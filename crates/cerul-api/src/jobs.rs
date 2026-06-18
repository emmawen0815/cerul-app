use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use async_trait::async_trait;
use cerul_pipeline::run::{Embedder, OcrEngine, PipelineProgress, Transcriber, VideoPipeline};
use cerul_storage::AppPaths;
use rusqlite::{params, OptionalExtension, TransactionBehavior};
use tokio::sync::Semaphore;

static DEFAULT_WORKER_STARTED: AtomicBool = AtomicBool::new(false);
const INDEXING_PAUSED_SETTING: &str = "indexing_paused";
const CONCURRENT_JOBS_SETTING: &str = "concurrent_jobs";
const DEFAULT_CONCURRENT_JOBS: usize = 2;
const MAX_CONCURRENT_JOBS: usize = 4;
const JOB_PROGRESS_MIN_INTERVAL: Duration = Duration::from_millis(500);
const JOB_PROGRESS_MIN_DELTA: f64 = 0.01;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ClaimedJob {
    pub id: String,
    pub item_id: String,
    pub job_type: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct JobOutcome {
    pub id: String,
    pub item_id: String,
    pub job_type: String,
    pub status: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CancelledJob {
    pub item_id: String,
    pub was_running: bool,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct IndexingSnapshot {
    pub paused: bool,
    pub indexed_items: u64,
    pub total_items: u64,
    pub queued_jobs: u64,
    pub running_jobs: u64,
    pub failed_jobs: u64,
}

impl IndexingSnapshot {
    pub fn has_pending_work(&self) -> bool {
        self.queued_jobs > 0 || self.running_jobs > 0
    }
}

#[async_trait]
pub trait JobProcessor: Send + Sync {
    async fn process(&self, job: &ClaimedJob) -> anyhow::Result<()>;
}

#[derive(Clone)]
pub struct PipelineJobProcessor {
    paths: AppPaths,
    pipeline: VideoPipeline,
}

impl PipelineJobProcessor {
    pub fn new(paths: AppPaths, pipeline: VideoPipeline) -> Self {
        Self { paths, pipeline }
    }
}

#[async_trait]
impl JobProcessor for PipelineJobProcessor {
    async fn process(&self, job: &ClaimedJob) -> anyhow::Result<()> {
        let result = match job.job_type.as_str() {
            "index_video" => self
                .pipeline
                .clone()
                .with_usage_job_id(job.id.clone())
                .with_progress(Arc::new(JobProgressReporter {
                    paths: self.paths.clone(),
                    job_id: job.id.clone(),
                    state: Mutex::new(JobProgressState::default()),
                }))
                .process_video_item(&job.item_id)
                .await
                .map(|_| ()),
            "index_audio" => self
                .pipeline
                .clone()
                .with_usage_job_id(job.id.clone())
                .process_audio_item(&job.item_id)
                .await
                .map(|_| ()),
            "index_image" => self
                .pipeline
                .clone()
                .with_usage_job_id(job.id.clone())
                .process_image_item(&job.item_id)
                .await
                .map(|_| ()),
            other => Err(anyhow::anyhow!("unsupported job type: {other}")),
        };

        self.pipeline.release_all_runtime_models(&job.item_id).await;
        result
    }
}

struct JobProgressReporter {
    paths: AppPaths,
    job_id: String,
    state: Mutex<JobProgressState>,
}

#[derive(Debug, Default)]
struct JobProgressState {
    stage: Option<&'static str>,
    progress: f64,
    last_write: Option<Instant>,
}

impl PipelineProgress for JobProgressReporter {
    fn update(&self, _item_id: &str, stage: &'static str, progress: f64, message: &str) {
        if !self.should_write(stage, progress) {
            return;
        }
        if let Err(error) = update_job_stage(&self.paths, &self.job_id, stage, progress, message) {
            tracing::warn!(%error, job_id = %self.job_id, stage, "failed to update job progress");
            return;
        }
        self.record_write(stage, progress);
    }
}

impl JobProgressReporter {
    fn should_write(&self, stage: &'static str, progress: f64) -> bool {
        let Ok(state) = self.state.lock() else {
            return true;
        };
        let stage_changed = state.stage != Some(stage);
        let progress_changed = (progress.clamp(0.0, 1.0) - state.progress).abs();
        let interval_elapsed = state
            .last_write
            .map(|last| last.elapsed() >= JOB_PROGRESS_MIN_INTERVAL)
            .unwrap_or(true);

        stage_changed
            || progress >= 1.0
            || progress_changed >= JOB_PROGRESS_MIN_DELTA
            || interval_elapsed
    }

    fn record_write(&self, stage: &'static str, progress: f64) {
        let Ok(mut state) = self.state.lock() else {
            return;
        };
        state.stage = Some(stage);
        state.progress = progress.clamp(0.0, 1.0);
        state.last_write = Some(Instant::now());
    }
}

#[derive(Clone)]
pub struct JobWorker {
    paths: AppPaths,
    processor: Arc<dyn JobProcessor>,
}

impl JobWorker {
    pub fn new(paths: AppPaths, processor: Arc<dyn JobProcessor>) -> Self {
        Self { paths, processor }
    }

    pub async fn run_next_queued_job(&self) -> anyhow::Result<Option<JobOutcome>> {
        if is_indexing_paused(&self.paths)? {
            return Ok(None);
        }

        let concurrency = effective_concurrent_jobs(&self.paths)?;
        let Some(job) = claim_next_job(&self.paths, concurrency)? else {
            return Ok(None);
        };

        mark_item_processing(&self.paths, &job)?;
        let result = self.processor.process(&job).await;

        if is_job_cancelled(&self.paths, &job.id)? {
            if let Ok(item) = cerul_storage::get_item(&self.paths, &job.item_id) {
                if let Err(error) = crate::cleanup_item_artifacts(&self.paths, &item).await {
                    tracing::warn!(
                        %error,
                        job_id = %job.id,
                        item_id = %job.item_id,
                        "failed to clean cancelled job artifacts"
                    );
                }
            }
            mark_job_cancelled_after_processing(&self.paths, &job)?;
            return Ok(Some(JobOutcome {
                id: job.id,
                item_id: job.item_id,
                job_type: job.job_type,
                status: "cancelled".to_string(),
            }));
        }

        match result {
            Ok(()) => {
                complete_job(&self.paths, &job)?;
                Ok(Some(JobOutcome {
                    id: job.id,
                    item_id: job.item_id,
                    job_type: job.job_type,
                    status: "completed".to_string(),
                }))
            }
            Err(error) => {
                let message = error.to_string();
                fail_job(&self.paths, &job, &message)?;
                Err(anyhow::anyhow!(message))
            }
        }
    }

    pub async fn run_forever(self, idle_sleep: Duration) {
        if let Err(error) = requeue_interrupted_jobs(&self.paths) {
            tracing::warn!(%error, "failed to requeue interrupted Cerul jobs");
        }

        let mut handles = Vec::with_capacity(MAX_CONCURRENT_JOBS);
        for slot in 0..MAX_CONCURRENT_JOBS {
            let worker = self.clone();
            handles.push(tokio::spawn(async move {
                worker.run_worker_slot(slot, idle_sleep).await;
            }));
        }

        for handle in handles {
            if let Err(error) = handle.await {
                tracing::warn!(%error, "Cerul indexing worker slot stopped unexpectedly");
            }
        }
    }

    async fn run_worker_slot(self, slot: usize, idle_sleep: Duration) {
        loop {
            match self.run_next_queued_job().await {
                Ok(Some(outcome)) => {
                    tracing::info!(
                        worker_slot = slot,
                        job_id = %outcome.id,
                        item_id = %outcome.item_id,
                        job_type = %outcome.job_type,
                        "completed Cerul indexing job"
                    );
                }
                Ok(None) => tokio::time::sleep(idle_sleep).await,
                Err(error) => {
                    tracing::warn!(%error, "Cerul indexing job failed");
                    tokio::time::sleep(idle_sleep).await;
                }
            }
        }
    }
}

pub fn spawn_job_worker(
    paths: AppPaths,
    processor: Arc<dyn JobProcessor>,
) -> tokio::task::JoinHandle<()> {
    let worker = JobWorker::new(paths, processor);
    tokio::spawn(worker.run_forever(Duration::from_secs(2)))
}

pub fn spawn_default_job_worker(paths: AppPaths) -> Option<tokio::task::JoinHandle<()>> {
    if env_flag_is_disabled("CERUL_PIPELINE_WORKER") {
        tracing::info!("Cerul pipeline worker disabled by CERUL_PIPELINE_WORKER=0");
        return None;
    }

    let selected_asr = crate::models::selected_asr_model_id(&paths)
        .unwrap_or_else(|| crate::models::DEFAULT_ASR_MODEL_ID.to_string());
    let inference_mode = effective_indexing_inference_mode(&paths);
    tracing::info!(
        asr_model = %selected_asr,
        inference_mode = %inference_mode,
        "Cerul pipeline worker starting"
    );

    if DEFAULT_WORKER_STARTED.swap(true, Ordering::AcqRel) {
        return None;
    }

    Some(tokio::spawn(async move {
        let processor = tokio::task::spawn_blocking(move || {
            default_pipeline_processor(paths.clone()).map(|processor| (paths, processor))
        })
        .await;

        match processor {
            Ok(Ok((paths, processor))) => {
                JobWorker::new(paths, Arc::new(processor))
                    .run_forever(Duration::from_secs(2))
                    .await;
            }
            Ok(Err(error)) => {
                DEFAULT_WORKER_STARTED.store(false, Ordering::Release);
                tracing::warn!(%error, "failed to start Cerul pipeline worker");
            }
            Err(error) => {
                DEFAULT_WORKER_STARTED.store(false, Ordering::Release);
                tracing::warn!(%error, "Cerul pipeline worker initialization task failed");
            }
        }
    }))
}

pub fn set_default_indexing_paused(paused: bool) -> anyhow::Result<()> {
    let paths = AppPaths::resolve()?;
    set_indexing_paused(&paths, paused)
}

pub fn default_indexing_paused() -> anyhow::Result<bool> {
    let paths = AppPaths::resolve()?;
    is_indexing_paused(&paths)
}

pub fn set_indexing_paused(paths: &AppPaths, paused: bool) -> anyhow::Result<()> {
    let conn = cerul_storage::sqlite::open(paths)?;
    conn.execute(
        r#"
        INSERT INTO settings (key, value, updated_at)
        VALUES (?1, ?2, strftime('%s','now'))
        ON CONFLICT(key) DO UPDATE SET
            value = excluded.value,
            updated_at = excluded.updated_at
        "#,
        (INDEXING_PAUSED_SETTING, paused.to_string()),
    )?;
    Ok(())
}

pub fn is_indexing_paused(paths: &AppPaths) -> anyhow::Result<bool> {
    let conn = cerul_storage::sqlite::open(paths)?;
    let value = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [INDEXING_PAUSED_SETTING],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    Ok(value.as_deref().is_some_and(parse_bool_setting))
}

pub fn default_indexing_snapshot() -> anyhow::Result<IndexingSnapshot> {
    let paths = AppPaths::resolve()?;
    indexing_snapshot(&paths)
}

pub fn indexing_snapshot(paths: &AppPaths) -> anyhow::Result<IndexingSnapshot> {
    let conn = cerul_storage::sqlite::open(paths)?;
    let paused = is_indexing_paused(paths)?;
    let indexed_items = count_rows(
        &conn,
        "SELECT COUNT(*) FROM items WHERE status = 'indexed' OR indexed_at IS NOT NULL",
    )?;
    let total_items = count_rows(&conn, "SELECT COUNT(*) FROM items")?;
    let queued_jobs = count_rows(&conn, "SELECT COUNT(*) FROM jobs WHERE status = 'queued'")?;
    let running_jobs = count_rows(&conn, "SELECT COUNT(*) FROM jobs WHERE status = 'running'")?;
    let failed_jobs = count_rows(&conn, "SELECT COUNT(*) FROM jobs WHERE status = 'failed'")?;

    Ok(IndexingSnapshot {
        paused,
        indexed_items,
        total_items,
        queued_jobs,
        running_jobs,
        failed_jobs,
    })
}

fn configured_concurrent_jobs(paths: &AppPaths) -> anyhow::Result<usize> {
    let conn = cerul_storage::sqlite::open(paths)?;
    let value = conn
        .query_row(
            "SELECT value FROM settings WHERE key = ?1",
            [CONCURRENT_JOBS_SETTING],
            |row| row.get::<_, String>(0),
        )
        .optional()?;

    Ok(value
        .as_deref()
        .and_then(parse_usize_setting)
        .unwrap_or(DEFAULT_CONCURRENT_JOBS)
        .clamp(1, MAX_CONCURRENT_JOBS))
}

fn effective_concurrent_jobs(paths: &AppPaths) -> anyhow::Result<usize> {
    let effective_mode = effective_indexing_inference_mode(paths);
    concurrent_jobs_for_effective_mode(paths, &effective_mode)
}

fn concurrent_jobs_for_effective_mode(
    paths: &AppPaths,
    _effective_mode: &str,
) -> anyhow::Result<usize> {
    configured_concurrent_jobs(paths)
}

pub fn requeue_interrupted_jobs(paths: &AppPaths) -> anyhow::Result<usize> {
    let conn = cerul_storage::sqlite::open(paths)?;
    let item_ids = {
        let mut stmt = conn.prepare(
            r#"
            SELECT item_id
            FROM jobs
            WHERE status = 'running'
              AND item_id IS NOT NULL
            "#,
        )?;
        let rows = stmt
            .query_map([], |row| row.get::<_, String>(0))?
            .collect::<Result<Vec<_>, _>>()?;
        rows
    };

    let updated = conn.execute(
        r#"
        UPDATE jobs
        SET status = 'queued',
            started_at = NULL,
            finished_at = NULL,
            error = NULL,
            progress = 0,
            stage = 'queued',
            stage_message = 'Queued'
        WHERE status = 'running'
        "#,
        [],
    )?;

    for item_id in item_ids {
        conn.execute(
            r#"
            UPDATE items
            SET status = 'discovered',
                indexed_at = NULL,
                error = NULL
            WHERE id = ?1
              AND status IN ('fetching', 'processing', 'indexed')
            "#,
            [item_id],
        )?;
    }

    Ok(updated)
}

fn build_pipeline_processor(
    paths: AppPaths,
    inference_mode: &str,
) -> anyhow::Result<PipelineJobProcessor> {
    let pipeline = if inference_mode == "local" {
        let profile =
            cerul_storage::vectors::ensure_embedding_profile_for_inference_mode(&paths, "local")?;
        let mut sidecar_config = cerul_pipeline::mlx_sidecar::runtime_config(&paths)?;
        crate::local_runtime::ensure_external_mlx_runtime(&paths, &mut sidecar_config)?;
        let sidecar = Arc::new(cerul_pipeline::mlx_sidecar::MlxSidecar::new(sidecar_config));
        let transcriber: Arc<dyn Transcriber> = sidecar.clone();
        let embedder: Arc<dyn Embedder> = sidecar.clone();
        let ocr: Arc<dyn OcrEngine> = sidecar.clone();
        let runtime_control: Arc<dyn cerul_pipeline::run::ModelRuntimeControl> = sidecar;
        let model_permits = Arc::new(Semaphore::new(1));
        VideoPipeline::new(paths.clone(), transcriber, embedder)
            .with_embedding_profile(profile)
            .with_ocr(ocr)
            .with_runtime_control(runtime_control)
            .with_model_permits(model_permits)
    } else {
        let profile =
            cerul_storage::vectors::ensure_embedding_profile_for_inference_mode(&paths, "remote")?;
        let transcriber = Arc::new(crate::api_models::routed_transcriber(paths.clone()));
        let embedder = Arc::new(crate::api_models::profiled_embedder(
            paths.clone(),
            profile.clone(),
        ));
        VideoPipeline::new(paths.clone(), transcriber, embedder).with_embedding_profile(profile)
    };
    Ok(PipelineJobProcessor::new(paths, pipeline))
}

fn default_pipeline_processor(paths: AppPaths) -> anyhow::Result<ModeAwareProcessor> {
    let inference_mode = effective_indexing_inference_mode(&paths);
    let processor = build_pipeline_processor(paths.clone(), &inference_mode)?;
    Ok(ModeAwareProcessor::new(
        paths,
        inference_mode,
        Arc::new(processor),
    ))
}

struct ModeProcessorState {
    mode: String,
    processor: Arc<dyn JobProcessor>,
}

/// Wraps the pipeline processor so the worker rebuilds its transcriber/embedder
/// when the user switches inference mode (Remote API <-> Local model) without
/// restarting. Without this the worker keeps the embedder it was built with,
/// so after a remote->local toggle it still emits 3072-dim vectors while chunk
/// writes validate against the local 2048-dim profile, failing every indexing
/// job until the app restarts.
struct ModeAwareProcessor {
    paths: AppPaths,
    state: tokio::sync::RwLock<ModeProcessorState>,
}

impl ModeAwareProcessor {
    fn new(paths: AppPaths, mode: String, processor: Arc<dyn JobProcessor>) -> Self {
        Self {
            paths,
            state: tokio::sync::RwLock::new(ModeProcessorState { mode, processor }),
        }
    }
}

#[async_trait]
impl JobProcessor for ModeAwareProcessor {
    async fn process(&self, job: &ClaimedJob) -> anyhow::Result<()> {
        let current = effective_indexing_inference_mode(&self.paths);

        // Fast path: mode unchanged since the processor was built — delegate.
        {
            let state = self.state.read().await;
            if state.mode == current {
                let processor = state.processor.clone();
                let result = processor.process(job).await;
                drop(state);
                return result;
            }
        }

        // Mode changed: rebuild under the write lock so concurrent worker slots
        // neither each rebuild nor run with a stale processor mid-switch.
        let mut state = self.state.write().await;
        if state.mode != current {
            let paths = self.paths.clone();
            let mode = current.clone();
            let rebuilt =
                tokio::task::spawn_blocking(move || build_pipeline_processor(paths, &mode))
                    .await??;
            tracing::info!(
                inference_mode = %current,
                "rebuilt indexing pipeline after inference mode change"
            );
            state.mode = current;
            state.processor = Arc::new(rebuilt);
        }
        let processor = state.processor.clone();
        let result = processor.process(job).await;
        drop(state);
        result
    }
}

fn configured_inference_mode(paths: &AppPaths) -> String {
    crate::setting_string(paths, "inference_mode")
        .ok()
        .flatten()
        .map(|value| value.trim().to_ascii_lowercase())
        .filter(|value| value == "remote" || value == "local" || value == "auto")
        .unwrap_or_else(|| "auto".to_string())
}

fn effective_indexing_inference_mode(paths: &AppPaths) -> String {
    let configured = configured_inference_mode(paths);
    if configured == "remote" {
        return "remote".to_string();
    }

    let runtime = crate::models::model_runtime_status(paths);
    match indexing_inference_mode(paths, &runtime) {
        Ok(mode) => {
            if configured == "auto" && mode != configured {
                tracing::warn!(
                    configured_mode = %configured,
                    effective_mode = %mode,
                    local_runtime_error = ?runtime.local_runtime_error,
                    "auto smart processing selected remote pipeline while local runtime is unavailable"
                );
            }
            mode
        }
        Err(error) => {
            if configured == "local" {
                tracing::warn!(
                    %error,
                    "local-only smart processing is selected; indexing will stay on the local pipeline"
                );
                "local".to_string()
            } else {
                tracing::warn!(
                    %error,
                    "failed to evaluate local runtime readiness; indexing with remote pipeline"
                );
                "remote".to_string()
            }
        }
    }
}

fn indexing_inference_mode(
    paths: &AppPaths,
    runtime: &crate::models::ModelRuntimeStatus,
) -> anyhow::Result<String> {
    let configured = configured_inference_mode(paths);
    if configured == "remote" {
        return Ok("remote".to_string());
    }

    crate::sync_deferred_embedding_rebuild_if_ready(paths, runtime)?;
    match configured.as_str() {
        "auto" if runtime.local_runtime_ready => Ok("local".to_string()),
        "auto" => Ok("remote".to_string()),
        "local" => Ok("local".to_string()),
        _ => Ok("remote".to_string()),
    }
}

pub fn env_flag_is_disabled(name: &str) -> bool {
    std::env::var(name).is_ok_and(|value| {
        matches!(
            value.trim().to_ascii_lowercase().as_str(),
            "0" | "false" | "off" | "no"
        )
    })
}

fn parse_bool_setting(value: &str) -> bool {
    match serde_json::from_str::<serde_json::Value>(value) {
        Ok(serde_json::Value::Bool(value)) => value,
        Ok(serde_json::Value::String(value)) => truthy_string(&value),
        _ => truthy_string(value),
    }
}

fn truthy_string(value: &str) -> bool {
    matches!(
        value.trim().to_ascii_lowercase().as_str(),
        "1" | "true" | "yes" | "on"
    )
}

fn parse_usize_setting(value: &str) -> Option<usize> {
    match serde_json::from_str::<serde_json::Value>(value) {
        Ok(serde_json::Value::Number(value)) => value.as_u64().map(|value| value as usize),
        Ok(serde_json::Value::String(value)) => value.trim().parse::<usize>().ok(),
        _ => value.trim().parse::<usize>().ok(),
    }
}

fn count_rows(conn: &rusqlite::Connection, sql: &str) -> anyhow::Result<u64> {
    let count: i64 = conn.query_row(sql, [], |row| row.get(0))?;
    Ok(count.try_into()?)
}

fn claim_next_job(paths: &AppPaths, max_running_jobs: usize) -> anyhow::Result<Option<ClaimedJob>> {
    let mut conn = cerul_storage::sqlite::open(paths)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let running_jobs: i64 = tx.query_row(
        "SELECT COUNT(*) FROM jobs WHERE status = 'running'",
        [],
        |row| row.get(0),
    )?;
    if running_jobs >= max_running_jobs.max(1) as i64 {
        tx.commit()?;
        return Ok(None);
    }

    let job = tx
        .query_row(
            r#"
            SELECT queued.id, queued.item_id, queued.job_type
            FROM jobs AS queued
            WHERE queued.status = 'queued'
              AND queued.item_id IS NOT NULL
              AND NOT EXISTS (
                  SELECT 1
                  FROM jobs AS running
                  WHERE running.status = 'running'
                    AND running.item_id = queued.item_id
                    AND running.job_type = queued.job_type
              )
            ORDER BY queued.id ASC
            LIMIT 1
            "#,
            [],
            |row| {
                Ok(ClaimedJob {
                    id: row.get(0)?,
                    item_id: row.get(1)?,
                    job_type: row.get(2)?,
                })
            },
        )
        .optional()?;

    let Some(job) = job else {
        tx.commit()?;
        return Ok(None);
    };

    let updated = tx.execute(
        r#"
        UPDATE jobs
        SET status = 'running',
            started_at = strftime('%s','now'),
            finished_at = NULL,
            error = NULL,
            progress = 0.05,
            stage = 'queued',
            stage_message = 'Starting'
        WHERE id = ?1
          AND status = 'queued'
        "#,
        [job.id.as_str()],
    )?;

    if updated == 0 {
        tx.commit()?;
        return Ok(None);
    }

    tx.execute(
        r#"
        UPDATE items
        SET status = 'fetching',
            error = NULL
        WHERE id = ?1
          AND status != 'indexed'
        "#,
        [job.item_id.as_str()],
    )?;

    tx.commit()?;
    Ok(Some(job))
}

fn mark_item_processing(paths: &AppPaths, job: &ClaimedJob) -> anyhow::Result<()> {
    let conn = cerul_storage::sqlite::open(paths)?;
    conn.execute(
        r#"
        UPDATE items
        SET status = 'processing',
            error = NULL
        WHERE id = ?1
        "#,
        [job.item_id.as_str()],
    )?;
    conn.execute(
        r#"
        UPDATE jobs
        SET progress = 0.1,
            stage = 'processing',
            stage_message = 'Preparing media'
        WHERE id = ?1
          AND status = 'running'
        "#,
        [job.id.as_str()],
    )?;
    Ok(())
}

fn complete_job(paths: &AppPaths, job: &ClaimedJob) -> anyhow::Result<()> {
    let conn = cerul_storage::sqlite::open(paths)?;
    conn.execute(
        r#"
        UPDATE jobs
        SET status = 'completed',
            finished_at = strftime('%s','now'),
            error = NULL,
            progress = 1,
            stage = 'completed',
            stage_message = 'Index complete'
        WHERE id = ?1
        "#,
        [job.id.as_str()],
    )?;
    Ok(())
}

fn fail_job(paths: &AppPaths, job: &ClaimedJob, error: &str) -> anyhow::Result<()> {
    let conn = cerul_storage::sqlite::open(paths)?;
    conn.execute(
        r#"
        UPDATE jobs
        SET status = 'failed',
            finished_at = strftime('%s','now'),
            error = ?2,
            progress = 1,
            stage = 'failed',
            stage_message = 'Index failed'
        WHERE id = ?1
        "#,
        params![job.id.as_str(), error],
    )?;
    conn.execute(
        r#"
        UPDATE items
        SET status = 'failed',
            error = ?2
        WHERE id = ?1
        "#,
        params![job.item_id.as_str(), error],
    )?;
    Ok(())
}

pub fn cancel_job(paths: &AppPaths, job_id: &str) -> anyhow::Result<Option<CancelledJob>> {
    let mut conn = cerul_storage::sqlite::open(paths)?;
    let tx = conn.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let job = tx
        .query_row(
            "SELECT item_id, status FROM jobs WHERE id = ?1",
            [job_id],
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()?;

    let Some((item_id, status)) = job else {
        tx.commit()?;
        return Ok(None);
    };
    let was_running = status == "running";

    if matches!(status.as_str(), "queued" | "running" | "failed") {
        tx.execute(
            r#"
            UPDATE jobs
            SET status = 'cancelled',
                finished_at = strftime('%s','now'),
                error = NULL,
                progress = 1,
                stage = 'cancelled',
                stage_message = 'Cancelled'
            WHERE id = ?1
            "#,
            [job_id],
        )?;
        if let Some(item_id) = item_id.as_deref() {
            tx.execute(
                r#"
                UPDATE items
                SET status = 'discovered',
                    error = NULL,
                    indexed_at = NULL
                WHERE id = ?1
                  AND status IN ('fetching', 'processing', 'failed')
                "#,
                [item_id],
            )?;
        }
    }

    tx.commit()?;
    Ok(item_id.map(|item_id| CancelledJob {
        item_id,
        was_running,
    }))
}

fn is_job_cancelled(paths: &AppPaths, job_id: &str) -> anyhow::Result<bool> {
    let conn = cerul_storage::sqlite::open(paths)?;
    let status = conn
        .query_row("SELECT status FROM jobs WHERE id = ?1", [job_id], |row| {
            row.get::<_, String>(0)
        })
        .optional()?;
    Ok(status.as_deref() == Some("cancelled"))
}

fn mark_job_cancelled_after_processing(paths: &AppPaths, job: &ClaimedJob) -> anyhow::Result<()> {
    let conn = cerul_storage::sqlite::open(paths)?;
    let item_status = conn
        .query_row(
            "SELECT status FROM items WHERE id = ?1",
            [job.item_id.as_str()],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    conn.execute(
        r#"
        UPDATE jobs
        SET status = 'cancelled',
            finished_at = COALESCE(finished_at, strftime('%s','now')),
            error = NULL,
            progress = 1,
            stage = 'cancelled',
            stage_message = 'Cancelled'
        WHERE id = ?1
        "#,
        [job.id.as_str()],
    )?;
    if item_status.as_deref() == Some("deleting") {
        conn.execute("DELETE FROM items WHERE id = ?1", [job.item_id.as_str()])?;
    } else {
        conn.execute(
            r#"
            UPDATE items
            SET status = 'discovered',
                error = NULL,
                indexed_at = NULL
            WHERE id = ?1
            "#,
            [job.item_id.as_str()],
        )?;
    }
    Ok(())
}

fn update_job_stage(
    paths: &AppPaths,
    job_id: &str,
    stage: &str,
    progress: f64,
    message: &str,
) -> anyhow::Result<()> {
    let conn = cerul_storage::sqlite::open(paths)?;
    conn.execute(
        r#"
        UPDATE jobs
        SET progress = ?2,
            stage = ?3,
            stage_message = ?4
        WHERE id = ?1
          AND status = 'running'
        "#,
        params![job_id, progress.clamp(0.0, 1.0), stage, message],
    )?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use cerul_storage::sqlite;
    use std::{path::Path, sync::Mutex};
    use tokio::process::Command;

    struct FakeProcessor {
        paths: AppPaths,
        calls: Mutex<Vec<String>>,
        fail: bool,
    }

    #[async_trait]
    impl JobProcessor for FakeProcessor {
        async fn process(&self, job: &ClaimedJob) -> anyhow::Result<()> {
            self.calls
                .lock()
                .unwrap()
                .push(format!("{}:{}", job.job_type, job.item_id));

            if self.fail {
                anyhow::bail!("fake indexing failure");
            }

            cerul_storage::mark_indexed(&self.paths, &job.item_id)?;
            Ok(())
        }
    }

    #[tokio::test]
    async fn worker_completes_queued_job_and_marks_item_indexed() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_data_dir(temp.path()).unwrap();
        insert_job(
            &paths,
            "job-1",
            "item-1",
            "index_video",
            "queued",
            "discovered",
        );
        let processor = Arc::new(FakeProcessor {
            paths: paths.clone(),
            calls: Mutex::new(Vec::new()),
            fail: false,
        });
        let worker = JobWorker::new(paths.clone(), processor.clone());

        let outcome = worker.run_next_queued_job().await.unwrap().unwrap();

        assert_eq!(outcome.status, "completed");
        assert_eq!(
            processor.calls.lock().unwrap().as_slice(),
            ["index_video:item-1"]
        );
        assert_job(&paths, "job-1", "completed", 1.0, None);
        assert_item_status(&paths, "item-1", "indexed", None);
    }

    #[tokio::test]
    async fn worker_records_failed_job_and_item_error() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_data_dir(temp.path()).unwrap();
        insert_job(
            &paths,
            "job-1",
            "item-1",
            "index_audio",
            "queued",
            "discovered",
        );
        let worker = JobWorker::new(
            paths.clone(),
            Arc::new(FakeProcessor {
                paths: paths.clone(),
                calls: Mutex::new(Vec::new()),
                fail: true,
            }),
        );

        let error = worker.run_next_queued_job().await.unwrap_err().to_string();

        assert!(error.contains("fake indexing failure"));
        assert_job(
            &paths,
            "job-1",
            "failed",
            1.0,
            Some("fake indexing failure"),
        );
        assert_item_status(&paths, "item-1", "failed", Some("fake indexing failure"));
    }

    #[tokio::test]
    async fn worker_marks_indexed_rebuild_job_failed_on_error() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_data_dir(temp.path()).unwrap();
        insert_job(
            &paths,
            "job-1",
            "item-1",
            "index_video",
            "queued",
            "indexed",
        );
        let worker = JobWorker::new(
            paths.clone(),
            Arc::new(FakeProcessor {
                paths: paths.clone(),
                calls: Mutex::new(Vec::new()),
                fail: true,
            }),
        );

        let error = worker.run_next_queued_job().await.unwrap_err().to_string();

        assert!(error.contains("fake indexing failure"));
        assert_job(
            &paths,
            "job-1",
            "failed",
            1.0,
            Some("fake indexing failure"),
        );
        assert_item_status(&paths, "item-1", "failed", Some("fake indexing failure"));
    }

    #[tokio::test]
    async fn worker_skips_queued_jobs_when_indexing_is_paused() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_data_dir(temp.path()).unwrap();
        insert_job(
            &paths,
            "job-1",
            "item-1",
            "index_video",
            "queued",
            "discovered",
        );
        set_indexing_paused(&paths, true).unwrap();
        let processor = Arc::new(FakeProcessor {
            paths: paths.clone(),
            calls: Mutex::new(Vec::new()),
            fail: false,
        });
        let worker = JobWorker::new(paths.clone(), processor.clone());

        let outcome = worker.run_next_queued_job().await.unwrap();

        assert_eq!(outcome, None);
        assert!(processor.calls.lock().unwrap().is_empty());
        assert_job(&paths, "job-1", "queued", 0.0, None);
        assert_item_status(&paths, "item-1", "discovered", None);
    }

    #[test]
    fn configured_concurrent_jobs_defaults_and_clamps() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_data_dir(temp.path()).unwrap();

        assert_eq!(
            configured_concurrent_jobs(&paths).unwrap(),
            DEFAULT_CONCURRENT_JOBS
        );

        set_setting(&paths, CONCURRENT_JOBS_SETTING, serde_json::json!(3));
        assert_eq!(configured_concurrent_jobs(&paths).unwrap(), 3);

        set_setting(&paths, CONCURRENT_JOBS_SETTING, serde_json::json!(99));
        assert_eq!(
            configured_concurrent_jobs(&paths).unwrap(),
            MAX_CONCURRENT_JOBS
        );

        set_setting(&paths, CONCURRENT_JOBS_SETTING, serde_json::json!(0));
        assert_eq!(configured_concurrent_jobs(&paths).unwrap(), 1);
    }

    #[test]
    fn effective_concurrent_jobs_respects_setting_for_local_and_remote_modes() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_data_dir(temp.path()).unwrap();
        set_setting(&paths, CONCURRENT_JOBS_SETTING, serde_json::json!(4));

        assert_eq!(
            concurrent_jobs_for_effective_mode(&paths, "remote").unwrap(),
            4
        );
        assert_eq!(
            concurrent_jobs_for_effective_mode(&paths, "local").unwrap(),
            4
        );
    }

    #[test]
    fn indexing_auto_uses_remote_until_local_runtime_ready() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_data_dir(temp.path()).unwrap();
        set_setting(&paths, "inference_mode", serde_json::json!("auto"));
        set_setting(
            &paths,
            "embedding_profile_rebuild_deferred_mode",
            serde_json::json!("auto"),
        );

        let mode = indexing_inference_mode(&paths, &local_runtime_status(false)).unwrap();

        assert_eq!(mode, "remote");
        assert_eq!(
            crate::setting_string(&paths, "embedding_profile_rebuild_deferred_mode").unwrap(),
            Some("auto".to_string())
        );
    }

    #[test]
    fn indexing_local_only_does_not_fallback_to_remote() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_data_dir(temp.path()).unwrap();
        set_setting(&paths, "inference_mode", serde_json::json!("local"));

        let mode = indexing_inference_mode(&paths, &local_runtime_status(false)).unwrap();

        assert_eq!(mode, "local");
    }

    #[test]
    fn indexing_mode_consumes_deferred_rebuild_when_local_runtime_ready() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_data_dir(temp.path()).unwrap();
        set_setting(&paths, "inference_mode", serde_json::json!("local"));
        set_setting(
            &paths,
            "embedding_profile_rebuild_deferred_mode",
            serde_json::json!("local"),
        );
        insert_job(
            &paths,
            "job-completed",
            "item-1",
            "index_video",
            "completed",
            "indexed",
        );

        let mode = indexing_inference_mode(&paths, &local_runtime_status(true)).unwrap();

        assert_eq!(mode, "local");
        assert_eq!(
            crate::setting_string(&paths, "embedding_profile_rebuild_deferred_mode").unwrap(),
            None
        );
        let conn = sqlite::open(&paths).unwrap();
        let queued_jobs: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM jobs WHERE item_id = 'item-1' AND status = 'queued'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(queued_jobs, 1);
    }

    #[test]
    fn default_remote_processor_starts_before_embedding_provider_is_configured() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_data_dir(temp.path()).unwrap();
        set_setting(&paths, "inference_mode", serde_json::json!("remote"));

        let processor = default_pipeline_processor(paths);

        assert!(processor.is_ok());
    }

    #[test]
    fn claim_next_job_allows_parallel_claims_up_to_configured_limit() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_data_dir(temp.path()).unwrap();
        set_setting(&paths, CONCURRENT_JOBS_SETTING, serde_json::json!(2));
        insert_job(
            &paths,
            "job-1",
            "item-1",
            "index_video",
            "queued",
            "discovered",
        );
        insert_job(
            &paths,
            "job-2",
            "item-2",
            "index_video",
            "queued",
            "discovered",
        );
        insert_job(
            &paths,
            "job-3",
            "item-3",
            "index_video",
            "queued",
            "discovered",
        );
        let limit = configured_concurrent_jobs(&paths).unwrap();

        assert_eq!(claim_next_job(&paths, limit).unwrap().unwrap().id, "job-1");
        assert_eq!(claim_next_job(&paths, limit).unwrap().unwrap().id, "job-2");
        assert_eq!(claim_next_job(&paths, limit).unwrap(), None);

        assert_job(&paths, "job-1", "running", 0.05, None);
        assert_job(&paths, "job-2", "running", 0.05, None);
        assert_job(&paths, "job-3", "queued", 0.0, None);
    }

    #[test]
    fn claim_next_job_waits_for_same_item_running_job() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_data_dir(temp.path()).unwrap();
        set_setting(&paths, CONCURRENT_JOBS_SETTING, serde_json::json!(2));
        insert_job(
            &paths,
            "job-running",
            "item-1",
            "index_video",
            "running",
            "processing",
        );
        {
            let conn = sqlite::open(&paths).unwrap();
            conn.execute(
                r#"
                INSERT INTO jobs (id, item_id, job_type, status, progress)
                VALUES ('job-followup', 'item-1', 'index_video', 'queued', 0)
                "#,
                [],
            )
            .unwrap();
        }
        insert_job(
            &paths,
            "job-other",
            "item-2",
            "index_video",
            "queued",
            "discovered",
        );
        let limit = configured_concurrent_jobs(&paths).unwrap();

        assert_eq!(
            claim_next_job(&paths, limit).unwrap().unwrap().id,
            "job-other"
        );
        assert_job(&paths, "job-followup", "queued", 0.0, None);

        let conn = sqlite::open(&paths).unwrap();
        conn.execute(
            "UPDATE jobs SET status = 'completed' WHERE id = 'job-running'",
            [],
        )
        .unwrap();
        assert_eq!(
            claim_next_job(&paths, limit).unwrap().unwrap().id,
            "job-followup"
        );
    }

    #[test]
    fn indexing_pause_setting_round_trips_and_snapshot_counts_work() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_data_dir(temp.path()).unwrap();
        insert_job(
            &paths,
            "job-queued",
            "item-queued",
            "index_video",
            "queued",
            "discovered",
        );
        insert_job(
            &paths,
            "job-running",
            "item-running",
            "index_video",
            "running",
            "processing",
        );
        insert_job(
            &paths,
            "job-failed",
            "item-failed",
            "index_video",
            "failed",
            "failed",
        );
        cerul_storage::mark_indexed(&paths, "item-running").unwrap();

        assert!(!is_indexing_paused(&paths).unwrap());
        set_indexing_paused(&paths, true).unwrap();

        let snapshot = indexing_snapshot(&paths).unwrap();

        assert!(snapshot.paused);
        assert_eq!(snapshot.indexed_items, 1);
        assert_eq!(snapshot.total_items, 3);
        assert_eq!(snapshot.queued_jobs, 1);
        assert_eq!(snapshot.running_jobs, 1);
        assert_eq!(snapshot.failed_jobs, 1);
        assert!(snapshot.has_pending_work());
    }

    #[test]
    fn requeue_interrupted_jobs_restores_running_items() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_data_dir(temp.path()).unwrap();
        insert_job(
            &paths,
            "job-1",
            "item-1",
            "index_image",
            "running",
            "processing",
        );
        cerul_storage::mark_indexed(&paths, "item-1").unwrap();

        let updated = requeue_interrupted_jobs(&paths).unwrap();

        assert_eq!(updated, 1);
        assert_job(&paths, "job-1", "queued", 0.0, None);
        assert_item_status(&paths, "item-1", "discovered", None);
        assert_item_indexed_at(&paths, "item-1", None);
    }

    #[test]
    fn cancel_job_marks_job_cancelled_and_keeps_item_retryable() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_data_dir(temp.path()).unwrap();
        insert_job(
            &paths,
            "job-1",
            "item-1",
            "index_video",
            "queued",
            "processing",
        );

        let cancelled = cancel_job(&paths, "job-1").unwrap();

        assert_eq!(
            cancelled,
            Some(CancelledJob {
                item_id: "item-1".to_string(),
                was_running: false,
            })
        );
        assert_job(&paths, "job-1", "cancelled", 1.0, None);
        assert_item_status(&paths, "item-1", "discovered", None);
    }

    #[test]
    fn cancelled_deleting_item_is_removed_after_processor_returns() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_data_dir(temp.path()).unwrap();
        insert_job(
            &paths,
            "job-1",
            "item-1",
            "index_video",
            "cancelled",
            "deleting",
        );
        let job = ClaimedJob {
            id: "job-1".to_string(),
            item_id: "item-1".to_string(),
            job_type: "index_video".to_string(),
        };

        mark_job_cancelled_after_processing(&paths, &job).unwrap();

        let conn = sqlite::open(&paths).unwrap();
        let item_count: i64 = conn
            .query_row(
                "SELECT COUNT(*) FROM items WHERE id = 'item-1'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        let job_count: i64 = conn
            .query_row("SELECT COUNT(*) FROM jobs WHERE id = 'job-1'", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(item_count, 0);
        assert_eq!(job_count, 0);
    }

    #[test]
    fn update_job_stage_records_running_progress() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_data_dir(temp.path()).unwrap();
        insert_job(
            &paths,
            "job-1",
            "item-1",
            "index_video",
            "running",
            "processing",
        );

        update_job_stage(&paths, "job-1", "transcribing", 0.48, "Transcribing audio").unwrap();

        let conn = sqlite::open(&paths).unwrap();
        let row = conn
            .query_row(
                "SELECT stage, stage_message, progress FROM jobs WHERE id = 'job-1'",
                [],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, f64>(2)?,
                    ))
                },
            )
            .unwrap();

        assert_eq!(row.0, "transcribing");
        assert_eq!(row.1, "Transcribing audio");
        assert_eq!(row.2, 0.48);
    }

    #[test]
    fn job_progress_reporter_throttles_small_same_stage_updates() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_data_dir(temp.path()).unwrap();
        insert_job(
            &paths,
            "job-1",
            "item-1",
            "index_video",
            "running",
            "processing",
        );
        let reporter = JobProgressReporter {
            paths: paths.clone(),
            job_id: "job-1".to_string(),
            state: Mutex::new(JobProgressState::default()),
        };

        reporter.update("item-1", "transcribing", 0.10, "first write");
        reporter.update("item-1", "transcribing", 0.105, "tiny update");
        assert_job_stage(&paths, "job-1", "transcribing", "first write", 0.10);

        reporter.update("item-1", "transcribing", 0.12, "large enough update");
        assert_job_stage(&paths, "job-1", "transcribing", "large enough update", 0.12);

        reporter.update("item-1", "embedding", 0.121, "stage changed");
        assert_job_stage(&paths, "job-1", "embedding", "stage changed", 0.121);
    }

    #[tokio::test]
    #[ignore = "runs real API-backed providers; configure OpenAI and Gemini providers first"]
    async fn api_default_worker_smoke_indexes_added_folder_video() {
        let sample_wav =
            std::env::var("CERUL_API_SMOKE_WAV").expect("CERUL_API_SMOKE_WAV is required");
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_data_dir(temp.path().join("app")).unwrap();
        let videos = temp.path().join("videos");
        std::fs::create_dir(&videos).unwrap();
        let video = videos.join("added-folder-video.mp4");
        create_video_with_audio(Path::new(&sample_wav), &video)
            .await
            .unwrap();

        let summary = crate::add_source_to_paths(
            &paths,
            crate::AddSourceRequest {
                source_type: "folder_video".to_string(),
                config: serde_json::json!({ "path": videos }),
            },
        )
        .await
        .unwrap();
        assert_eq!(summary.queued_jobs, 1);
        let item_id = summary.items.first().unwrap().id.clone();

        let processor = default_pipeline_processor(paths.clone()).unwrap();
        let worker = JobWorker::new(paths.clone(), Arc::new(processor));
        let outcome = worker.run_next_queued_job().await.unwrap().unwrap();

        assert_eq!(outcome.item_id, item_id);
        assert_eq!(outcome.status, "completed");
        assert_item_status(&paths, &item_id, "indexed", None);

        let conn = sqlite::open(&paths).unwrap();
        let transcript_count = chunk_count(&conn, &item_id, "transcript");
        let ocr_count = chunk_count(&conn, &item_id, "ocr");
        let keyframe_count = chunk_count(&conn, &item_id, "keyframe");
        assert!(transcript_count > 0);
        assert_eq!(ocr_count, 0);
        assert!(keyframe_count > 0);
        drop(conn);

        let profile = cerul_storage::vectors::ensure_active_embedding_profile(&paths).unwrap();
        let collections = cerul_storage::vectors::collection_names(&paths, &profile);
        assert_eq!(
            cerul_storage::vectors::collection_point_count(&paths, &collections.text)
                .await
                .unwrap(),
            transcript_count as usize
        );
        assert_eq!(
            cerul_storage::vectors::collection_point_count(&paths, &collections.image)
                .await
                .unwrap(),
            keyframe_count as usize
        );

        println!(
            "api_default_worker_smoke item={} transcripts={} keyframes={}",
            item_id, transcript_count, keyframe_count
        );
    }

    #[tokio::test]
    #[ignore = "release smoke; run scripts/smoke-restart-resilience.sh"]
    async fn restart_resilience_smoke_requeues_once_and_keeps_indexes_readable() {
        let temp = tempfile::tempdir().unwrap();
        let paths = AppPaths::from_data_dir(temp.path()).unwrap();
        seed_indexed_search_item(&paths).await;
        insert_job(
            &paths,
            "job-running",
            "item-running",
            "index_video",
            "running",
            "processing",
        );

        let updated = requeue_interrupted_jobs(&paths).unwrap();

        assert_eq!(updated, 1);
        assert_job(&paths, "job-running", "queued", 0.0, None);
        assert_item_status(&paths, "item-running", "discovered", None);
        assert_eq!(job_count_for_item(&paths, "item-running"), 1);

        let search_results = cerul_search::search_with_vector(
            &paths,
            cerul_search::SearchRequest {
                q: "restart resilience phrase".to_string(),
                limit: 3,
            },
            fake_vector(7),
        )
        .await
        .unwrap();
        assert!(
            search_results.iter().any(|result| {
                result.item_id == "item-indexed"
                    && result.snippet.contains("restart resilience phrase")
            }),
            "expected SQLite + Qdrant search to remain readable, got {search_results:?}"
        );

        let processor = Arc::new(FakeProcessor {
            paths: paths.clone(),
            calls: Mutex::new(Vec::new()),
            fail: false,
        });
        let worker = JobWorker::new(paths.clone(), processor.clone());
        let outcome = worker.run_next_queued_job().await.unwrap().unwrap();

        assert_eq!(outcome.id, "job-running");
        assert_eq!(
            processor.calls.lock().unwrap().as_slice(),
            ["index_video:item-running"]
        );
        assert_job(&paths, "job-running", "completed", 1.0, None);
        assert_item_status(&paths, "item-running", "indexed", None);
        assert_eq!(job_count_for_item(&paths, "item-running"), 1);
        assert_eq!(requeue_interrupted_jobs(&paths).unwrap(), 0);
        assert_eq!(worker.run_next_queued_job().await.unwrap(), None);

        println!(
            "restart_resilience_smoke requeued=1 processed=1 search_hits={} jobs_for_resumed_item=1",
            search_results.len()
        );
    }

    async fn seed_indexed_search_item(paths: &AppPaths) {
        let conn = sqlite::open(paths).unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO sources (id, type, config, status) VALUES ('source-1', 'folder_video', '{}', 'active')",
            [],
        )
        .unwrap();
        conn.execute(
            r#"
            INSERT INTO items (id, source_id, content_type, status, title, metadata)
            VALUES ('item-indexed', 'source-1', 'video', 'indexed', 'Indexed smoke item', '{}')
            "#,
            [],
        )
        .unwrap();
        drop(conn);

        cerul_storage::write_video_chunks(
            paths,
            "item-indexed",
            &[cerul_storage::StorageTranscriptChunk {
                start: 12.0,
                end: 24.0,
                text: "restart resilience phrase from a previously indexed item".to_string(),
            }],
            &[],
            &[fake_vector(7)],
            &[],
        )
        .await
        .unwrap();
    }

    fn insert_job(
        paths: &AppPaths,
        job_id: &str,
        item_id: &str,
        job_type: &str,
        job_status: &str,
        item_status: &str,
    ) {
        let conn = sqlite::open(paths).unwrap();
        conn.execute(
            "INSERT OR IGNORE INTO sources (id, type, config, status) VALUES ('source-1', 'folder_video', '{}', 'active')",
            [],
        )
        .unwrap();
        conn.execute(
            r#"
            INSERT INTO items (id, source_id, content_type, external_id, status, metadata)
            VALUES (?1, 'source-1', 'video', ?1, ?2, '{}')
            "#,
            (item_id, item_status),
        )
        .unwrap();
        conn.execute(
            r#"
            INSERT INTO jobs (id, item_id, job_type, status, progress)
            VALUES (?1, ?2, ?3, ?4, 0)
            "#,
            (job_id, item_id, job_type, job_status),
        )
        .unwrap();
    }

    fn set_setting(paths: &AppPaths, key: &str, value: serde_json::Value) {
        let conn = sqlite::open(paths).unwrap();
        conn.execute(
            r#"
            INSERT INTO settings (key, value, updated_at)
            VALUES (?1, ?2, strftime('%s','now'))
            ON CONFLICT(key) DO UPDATE SET
                value = excluded.value,
                updated_at = excluded.updated_at
            "#,
            (key, value.to_string()),
        )
        .unwrap();
    }

    fn local_runtime_status(local_runtime_ready: bool) -> crate::models::ModelRuntimeStatus {
        crate::models::ModelRuntimeStatus {
            platform: "test".to_string(),
            api_runtime_ready: false,
            local_runtime_ready,
            openai_ready: false,
            gemini_ready: false,
            last_error: Some(
                "Connect OpenAI ASR provider and Gemini Embedding 2 provider before indexing."
                    .to_string(),
            ),
            local_runtime_error: if local_runtime_ready {
                None
            } else {
                Some("missing mlx".to_string())
            },
        }
    }

    fn assert_job(
        paths: &AppPaths,
        job_id: &str,
        status: &str,
        progress: f64,
        error: Option<&str>,
    ) {
        let conn = sqlite::open(paths).unwrap();
        let row = conn
            .query_row(
                "SELECT status, progress, error FROM jobs WHERE id = ?1",
                [job_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, f64>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .unwrap();

        assert_eq!(row.0, status);
        assert_eq!(row.1, progress);
        assert_eq!(row.2.as_deref(), error);
    }

    fn assert_job_stage(paths: &AppPaths, job_id: &str, stage: &str, message: &str, progress: f64) {
        let conn = sqlite::open(paths).unwrap();
        let row = conn
            .query_row(
                "SELECT stage, stage_message, progress FROM jobs WHERE id = ?1",
                [job_id],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, f64>(2)?,
                    ))
                },
            )
            .unwrap();

        assert_eq!(row.0, stage);
        assert_eq!(row.1, message);
        assert_eq!(row.2, progress);
    }

    fn assert_item_status(paths: &AppPaths, item_id: &str, status: &str, error: Option<&str>) {
        let conn = sqlite::open(paths).unwrap();
        let row = conn
            .query_row(
                "SELECT status, error FROM items WHERE id = ?1",
                [item_id],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
            )
            .unwrap();

        assert_eq!(row.0, status);
        assert_eq!(row.1.as_deref(), error);
    }

    fn assert_item_indexed_at(paths: &AppPaths, item_id: &str, indexed_at: Option<i64>) {
        let conn = sqlite::open(paths).unwrap();
        let value = conn
            .query_row(
                "SELECT indexed_at FROM items WHERE id = ?1",
                [item_id],
                |row| row.get::<_, Option<i64>>(0),
            )
            .unwrap();

        assert_eq!(value, indexed_at);
    }

    fn job_count_for_item(paths: &AppPaths, item_id: &str) -> i64 {
        let conn = sqlite::open(paths).unwrap();
        conn.query_row(
            "SELECT COUNT(*) FROM jobs WHERE item_id = ?1",
            [item_id],
            |row| row.get(0),
        )
        .unwrap()
    }

    fn chunk_count(conn: &rusqlite::Connection, item_id: &str, chunk_type: &str) -> i64 {
        conn.query_row(
            "SELECT COUNT(*) FROM chunks WHERE item_id = ?1 AND chunk_type = ?2",
            (item_id, chunk_type),
            |row| row.get(0),
        )
        .unwrap()
    }

    async fn create_video_with_audio(audio: &Path, out: &Path) -> anyhow::Result<()> {
        let output = Command::new("ffmpeg")
            .args([
                "-y",
                "-f",
                "lavfi",
                "-i",
                "color=c=black:s=640x360:d=24,drawtext=fontfile=/System/Library/Fonts/Supplemental/Arial.ttf:text=CERUL:fontcolor=white:fontsize=96:x=(w-text_w)/2:y=(h-text_h)/2",
                "-i",
            ])
            .arg(audio)
            .args([
                "-c:v",
                "mpeg4",
                "-c:a",
                "aac",
                "-pix_fmt",
                "yuv420p",
            ])
            .arg(out)
            .output()
            .await?;

        if !output.status.success() {
            anyhow::bail!(
                "ffmpeg API worker smoke video generation failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
        }

        Ok(())
    }

    fn fake_vector(seed: usize) -> Vec<f32> {
        let mut vector = vec![0.0; cerul_storage::vectors::VECTOR_DIMENSIONS as usize];
        let index = seed % vector.len();
        vector[index] = 1.0;
        vector
    }
}
