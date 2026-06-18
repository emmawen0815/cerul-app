// Cerul Desktop — main application shell.
//
// NOTE on size: this file still hosts every screen, dialog, and helper.
// Splitting it into smaller modules is a tracked follow-up. Phase A
// of that split is done (formatters and settings helpers moved into
// ./lib/formatters.ts and ./lib/settings-helpers.ts). The remaining
// phases are tracked in this comment so the next contributor can pick
// up cleanly:
//
//   Phase B — extract leaf components into ./components/
//     InlineNotice, EmptyState, Metric, ModelDownloadBanner,
//     CoreBanner, ResultCard, ItemCard, ItemModalityIcon,
//     DetailIssuePanel.
//   Phase C — extract screens into ./screens/
//     HomeScreen, ResultsScreen, ResultDetail, LibraryScreen,
//     ItemDetail, SourcesScreen, SettingsScreen, Onboarding.
//   Phase D — extract dialogs into ./dialogs/
//     ConfirmDialog, JobsSheet, AddSourceDialog (+ tabs).
//   Phase E — extract item / source / job / result mappers into
//     ./lib/mappers.ts and route helpers into ./lib/route.ts.
//
// Each phase should land as its own PR so the diff stays reviewable.

import {
  AlertTriangle,
  ArrowRight,
  Check,
  ChevronDown,
  ChevronRight,
  CircleDot,
  Clock,
  Copy,
  Cpu,
  Database,
  Download,
  ExternalLink,
  FileAudio,
  FileVideo,
  Folder,
  FolderDown,
  HardDrive,
  Image as ImageIcon,
  Info,
  Library,
  ListChecks,
  ListFilter,
  Loader2,
  Lock,
  Mic,
  MoreHorizontal,
  Eye,
  Pause,
  Play,
  Plus,
  Podcast,
  RefreshCcw,
  ReceiptText,
  Search,
  Settings,
  SlidersHorizontal,
  Sparkles,
  Star,
  Trash2,
  Video,
  Wrench,
  Youtube,
  Wallet,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useCallback, useEffect, useRef, useState, useMemo } from "react";
import type { FormEvent, KeyboardEvent, ReactNode, RefObject } from "react";
import * as api from "./lib/api";
import { useAuthStore } from "./lib/cloud/authStore";
import { appLocaleTag, LangProvider, useLang, useT, type TFunction } from "./lib/i18n";
import {
  errorMessage,
  extractChunkIdFromThumbnail,
  formatBytes,
  formatDuration,
  formatSpeed,
  formatTimestamp,
  formatUsd,
  metadataString,
  parseTimestampSeconds,
  pluralize,
  uniqueStrings,
  formatHotkeyLabel,
  buildMomentCitation,
} from "./lib/formatters";
import {
  resolveThemePreference,
  settingBoolean,
  settingNumber,
  settingString,
} from "./lib/settings-helpers";
import {
  EmptyState,
  InlineNotice,
} from "./components/leaf";
import { useClickOutside, useEscapeToClose, useDialogFocus } from "./lib/use-dismissable";
import {
  ProgressBar,
  StatusBadge,
  TranscriptList,
  TranscriptSkeleton,
  highlightSnippet,
} from "./components/transcript";
import { DetailIssuePanel } from "./components/detail-issue-panel";
import { CerulPlayer, type PlayerChapter, type PlayerMarker } from "./components/player";
import {
  ClipExportButton,
  resolveClipTarget as resolveClipTarget_,
  type ClipTarget,
} from "./components/clip-export-popover";
import {
  ItemCard,
  ItemModalityIcon,
  ResultCard,
  ResultModalityIcon,
  itemModalityLabel,
} from "./components/cards";
import { CoreStatusToast, useCoreStatus } from "./components/core-banner";
import { SourceRow } from "./components/source-row";
import { SourcePreview } from "./components/source-preview";
import {
  AccessibilityPermissionCallout,
  OnboardingFolderPicker,
  OnboardingYoutubePicker,
} from "./components/onboarding-pickers";
import {
  addSourceDisabled,
  uniqueYoutubeChannels,
  validateHttpUrl,
  waitForValidationFrame,
  youtubeChannelFromUrl,
} from "./lib/validation";
import { ConfirmDialog } from "./dialogs/confirm-dialog";
import { JobsSheet } from "./dialogs/jobs-sheet";
import { LocalModelConsent } from "./components/local-model-consent";
import { useLocalModelConsent } from "./lib/use-local-model-consent";
import { IndexingStrip } from "./components/indexing-strip";
import { AddSourceDialog } from "./dialogs/add-source-dialog";
import { SourcesScreen } from "./screens/sources";
import { Onboarding } from "./screens/onboarding";
import { BrandLogo, BrandMark } from "./components/brand";
import { AccountRailButton } from "./components/account-sidebar";
import type {
  ApiStatus,
  AppData,
  ConfirmOptions,
  ConfirmRequest,
  DaemonInstallResult,
  DaemonStatus,
  DetailIssue,
  Item,
  ItemSourceKind,
  ItemStatus,
  OnboardingYoutubeChannel,
  RequestConfirm,
  Result,
  ResultMatch,
  ResultModalityFilter,
  RouteState,
  SaveStatus,
  SettingsActionStatus,
  Source,
  SourceStatus,
  TranscriptLine,
  ValidationState,
  ValidationStatus,
  View,
} from "./lib/types";
import {
  isActiveJob,
  itemColor,
  itemDetailIssue,
  itemKindLabel,
  itemOriginalUrl,
  itemProgressLabel,
  itemSourceKind,
  itemSourceLabel,
  itemStatus,
  isNearEndPosition,
  latestActiveJobForItem,
  mapItemRecord,
  normalizeJobProgress,
} from "./lib/items";
import { coarseStepKey } from "./lib/jobs";
import {
  mapSourceRecord,
  sourceError,
  sourceName,
  sourceStatus,
  sourceType,
} from "./lib/sources";
import {
  mapChunkRecords,
  mapSearchResults,
  resultModality,
  selectPlaybackChunkId,
} from "./lib/results";
import { readRouteState, routeHash } from "./lib/route";
import {
  canOpenOriginalSource,
  timestampDeepLink,
} from "./lib/detail";
import { durationMinutes, sortLibraryItems } from "./lib/library";
import { loadPersistedUiState, persistLastRoute, persistOnboardingCompleted } from "./lib/uiStore";
import type { PersistedRoute } from "./lib/uiStore";
import {
  checkForDesktopUpdate,
  downloadDesktopUpdate,
  getDesktopAppVersion,
  getDesktopUpdaterDiagnostics,
  getDesktopUpdaterState,
  hasDesktopHost,
  installDesktopUpdate,
  invokeHostCommand,
  openDialog,
  runDesktopUpdaterCheck,
  subscribeDesktopUpdater,
} from "./lib/desktopHost";
import type { DesktopUpdate, DesktopUpdaterState } from "./lib/desktopHost";

// Top-level navigation. Sub-pages (`result-detail`, `item-detail`) are reached
// by clicking a search result or library item, not from the sidebar.
// `onboarding` auto-opens on a fresh/cleared install (no completed-onboarding
// flag) and can be re-run later via Settings → "Re-run onboarding"; it is not a
// permanent destination.
// All valid View ids — broader than the sidebar so persisted routes for
// sub-pages (result-detail, item-detail) and onboarding still rehydrate.
const viewIds: View[] = [
  "home",
  "results",
  "result-detail",
  "library",
  "moments",
  "entity-detail",
  "item-detail",
  "sources",
  "settings",
  "onboarding",
];

// Mapping from sub-pages to their sidebar parent so the sidebar still
// highlights the right top-level item when a sub-page is active.
const sidebarParentFor: Partial<Record<View, View>> = {
  "results": "home",
  "result-detail": "home",
  "entity-detail": "library",
  "item-detail": "library",
};
const globalHotkeyOptions = ["Alt+Space", "Ctrl+Space", "Ctrl+Shift+Space", "Cmd+Shift+Space"];
const recentSearchesStorageKey = "cerul.recentSearches.v1";
const lastOpenedStorageKey = "cerul.lastOpened.v1";
const lastAutomaticUpdateCheckStorageKey = "cerul.updater.lastAutomaticCheckAt.v1";
const automaticUpdateCheckIntervalMs = 6 * 60 * 60 * 1000;
const automaticUpdateStartupDelayRangeMs = [30_000, 90_000] as const;
const automaticUpdateResumeDelayRangeMs = [10_000, 60_000] as const;
const automaticUpdateWakeProbeIntervalMs = 60_000;
const automaticUpdateWakeGapMs = 5 * 60 * 1000;
const automaticUpdateOfflineRetryMs = 15 * 60 * 1000;
const manualUpdateCheckCooldownMs = 30_000;

function recordLastOpened(itemId: string, timestamp?: string | null) {
  try {
    window.localStorage.setItem(
      lastOpenedStorageKey,
      JSON.stringify({ itemId, timestamp: timestamp ?? null, at: Date.now() }),
    );
  } catch {
    // localStorage may be unavailable; continue-watching is best-effort.
  }
}

function forgetLastOpened(itemId: string) {
  try {
    const current = readLastOpened();
    if (!current || current.itemId === itemId) {
      window.localStorage.removeItem(lastOpenedStorageKey);
    }
  } catch {
    // localStorage may be unavailable; continue-watching is best-effort.
  }
}

function readLastOpened(): { itemId: string; timestamp: string | null; at: number } | null {
  try {
    const raw = window.localStorage.getItem(lastOpenedStorageKey);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as { itemId?: unknown; timestamp?: unknown; at?: unknown };
    if (parsed && typeof parsed.itemId === "string") {
      return {
        itemId: parsed.itemId,
        timestamp: typeof parsed.timestamp === "string" ? parsed.timestamp : null,
        at: typeof parsed.at === "number" && Number.isFinite(parsed.at) ? parsed.at : 0,
      };
    }
  } catch {
    // ignore malformed storage
  }
  return null;
}

function hasOpenModalSurface() {
  // Every transient surface must be reachable from this selector, otherwise
  // page-level Escape handlers fire underneath it (e.g. detail "back").
  return Boolean(document.querySelector(".scrim, .account-pop, .menu, [role='dialog']"));
}

function usePlaybackPositionPersistence({
  itemId,
  videoRef,
  chunkId,
  enabled,
}: {
  itemId: string;
  videoRef: RefObject<HTMLVideoElement | null>;
  chunkId: string | null;
  enabled: boolean;
}) {
  const lastSavedAtRef = useRef(0);
  const chunkIdRef = useRef(chunkId);

  useEffect(() => {
    chunkIdRef.current = chunkId;
  }, [chunkId]);

  useEffect(() => {
    if (!enabled) {
      return;
    }
    const video = videoRef.current;
    if (!video) {
      return;
    }

    let disposed = false;
    const clearSavedPosition = () => {
      forgetLastOpened(itemId);
      void api
        .updatePlaybackPosition(itemId, 0, null)
        .catch((error) => console.warn("failed to clear playback position", error));
    };
    const persist = (force: boolean) => {
      if (disposed) {
        return;
      }
      const positionSec = video.currentTime;
      if (!Number.isFinite(positionSec) || positionSec < 1) {
        return;
      }
      if (isNearEndPosition(positionSec, video.duration)) {
        if (force) {
          clearSavedPosition();
        }
        return;
      }
      const now = Date.now();
      if (!force && now - lastSavedAtRef.current < 10_000) {
        return;
      }
      lastSavedAtRef.current = now;
      const timestamp = formatTimestamp(positionSec);
      recordLastOpened(itemId, timestamp);
      void api
        .updatePlaybackPosition(itemId, positionSec, chunkIdRef.current)
        .catch((error) => console.warn("failed to save playback position", error));
    };
    const persistThrottled = () => persist(false);
    const persistForced = () => persist(true);

    video.addEventListener("timeupdate", persistThrottled);
    video.addEventListener("pause", persistForced);
    video.addEventListener("ended", clearSavedPosition);
    window.addEventListener("pagehide", persistForced);
    return () => {
      persistForced();
      disposed = true;
      video.removeEventListener("timeupdate", persistThrottled);
      video.removeEventListener("pause", persistForced);
      video.removeEventListener("ended", clearSavedPosition);
      window.removeEventListener("pagehide", persistForced);
    };
  }, [enabled, itemId, videoRef]);
}

async function readDaemonStatus() {
  if (!hasDesktopHost()) {
    return null;
  }
  try {
    return await invokeHostCommand<DaemonStatus>("daemon_status");
  } catch (error) {
    console.warn("failed to read Cerul daemon status", error);
    return null;
  }
}

async function installDaemon() {
  return invokeHostCommand<DaemonInstallResult>("install_daemon");
}

async function uninstallDaemon() {
  return invokeHostCommand<DaemonInstallResult>("uninstall_daemon");
}

function openAccessibilitySettings() {
  void invokeHostCommand("open_accessibility_settings").catch((error) => {
    console.warn("failed to open Accessibility settings", error);
  });
}

async function revealDataDirectory() {
  await invokeHostCommand("reveal_data_directory");
}

async function revealLogsDirectory() {
  await invokeHostCommand("reveal_logs_directory");
}

async function revealSourcePath(path: string) {
  await invokeHostCommand("reveal_source_path", { path });
}

type StorageLocations = {
  data_dir: string;
  cache_dir: string;
  models_dir: string;
  index_dir: string;
};

async function readStorageLocations() {
  return invokeHostCommand<StorageLocations>("storage_locations");
}

async function clearCacheDirectory() {
  return invokeHostCommand<{ cache_dir: string; bytes_removed: number }>("clear_cache");
}

async function resetLocalDataAndRestart() {
  return invokeHostCommand<{ scheduled: boolean; targets: Array<{ label: string; path: string }> }>(
    "reset_local_data",
  );
}

async function setGlobalHotkey(label: string) {
  await invokeHostCommand("set_global_hotkey", { label });
}

function readRecentSearches() {
  try {
    const raw = window.localStorage.getItem(recentSearchesStorageKey);
    if (!raw) {
      return [];
    }
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed
        .filter((value): value is string => typeof value === "string" && value.trim().length > 0)
        .slice(0, 5)
      : [];
  } catch {
    return [];
  }
}

function writeRecentSearches(searches: string[]) {
  try {
    window.localStorage.setItem(recentSearchesStorageKey, JSON.stringify(searches.slice(0, 5)));
  } catch {
    // Recent searches are a convenience only; storage failures should not block search.
  }
}

function randomDelay([min, max]: readonly [number, number]) {
  return min + Math.floor(Math.random() * (max - min + 1));
}

function readLastAutomaticUpdateCheckAt() {
  try {
    const raw = window.localStorage.getItem(lastAutomaticUpdateCheckStorageKey);
    if (!raw) {
      return null;
    }
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  } catch {
    return null;
  }
}

function writeLastAutomaticUpdateCheckAt(timestamp: number) {
  try {
    window.localStorage.setItem(lastAutomaticUpdateCheckStorageKey, String(timestamp));
  } catch {
    // Update checks still work without persistence; they just fall back to this session.
  }
}

function automaticUpdateCheckIsDue(now = Date.now()) {
  const lastCheckAt = readLastAutomaticUpdateCheckAt();
  if (!lastCheckAt) {
    return true;
  }
  if (lastCheckAt > now + automaticUpdateCheckIntervalMs) {
    return true;
  }
  return now - lastCheckAt >= automaticUpdateCheckIntervalMs;
}

function nextAutomaticUpdateCheckDelay(now = Date.now()) {
  const lastCheckAt = readLastAutomaticUpdateCheckAt();
  if (!lastCheckAt || lastCheckAt > now + automaticUpdateCheckIntervalMs) {
    return 0;
  }
  return Math.max(0, lastCheckAt + automaticUpdateCheckIntervalMs - now);
}

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function searchIndexIsSettling(data: AppData) {
  return (
    data.jobs.some(isActiveJob) ||
    data.items.some(
      (item) =>
        item.embeddingIndexStatus === "pending" ||
        item.visualIndexStatus === "pending",
    )
  );
}


// Fallback transcript shown before the real lines load (or when the core is
// offline) — intentionally empty so the UI never shows placeholder content.
const transcript: TranscriptLine[] = [];

const settingsSections = ["Models", "Usage", "General", "Indexing", "Storage", "Advanced", "About"] as const;
type SettingsSection = (typeof settingsSections)[number];

function normalizeSettingsSection(section?: string | null): SettingsSection {
  if (section === "Cerul Cloud") {
    return "Models";
  }
  if (settingsSections.includes(section as SettingsSection)) {
    return section as SettingsSection;
  }
  return "Models";
}

function hashQueryParam(name: string): string | null {
  const [, queryString = ""] = window.location.hash.replace(/^#/, "").split("?");
  return new URLSearchParams(queryString).get(name);
}

// Single source of truth for the non-online core-status wording, so the home
// status line and the rail footer never contradict each other (one used to
// say "正在启动" while the other said "核心离线" for the same state). The
// CoreBanner keeps its own prominent starting→unresponsive escalation.
function coreStatusText(status: ApiStatus, t: TFunction): string {
  return status === "connecting" ? t("shell.coreConnecting") : t("shell.coreOffline");
}

// Tracks, per running job, the wall-clock second its current coarse step began.
// The backend only timestamps the whole job, so we observe step transitions here
// to drive a "this step: M:SS" readout. A job's timer resets when its step
// changes; finished jobs are dropped.
function useStepStarts(jobs: api.JobRecord[]): Record<string, number> {
  const ref = useRef<Map<string, { step: string; at: number }>>(new Map());
  const [starts, setStarts] = useState<Record<string, number>>({});
  useEffect(() => {
    const now = Date.now() / 1000;
    const map = ref.current;
    const live = new Set<string>();
    let changed = false;
    for (const job of jobs) {
      const step = coarseStepKey(job);
      if (job.status !== "running" || !step) {
        continue;
      }
      live.add(job.id);
      const prev = map.get(job.id);
      if (!prev || prev.step !== step) {
        map.set(job.id, { step, at: now });
        changed = true;
      }
    }
    for (const id of Array.from(map.keys())) {
      if (!live.has(id)) {
        map.delete(id);
        changed = true;
      }
    }
    if (changed) {
      const next: Record<string, number> = {};
      map.forEach((value, id) => {
        next[id] = value.at;
      });
      setStarts(next);
    }
  }, [jobs]);
  return starts;
}

export function App() {
  return (
    <LangProvider>
      <AppWorkspace />
    </LangProvider>
  );
}

function AppWorkspace() {
  const t = useT();
  const exchangeOAuthCode = useAuthStore((state) => state.exchangeOAuthCode);
  const initialRoute = readRouteState();
  const [view, setViewState] = useState<View>(initialRoute.view);
  const [selectedItemId, setSelectedItemId] = useState<string | null>(initialRoute.itemId);
  const [selectedChunkId, setSelectedChunkId] = useState<string | null>(initialRoute.chunkId);
  const [selectedTimestamp, setSelectedTimestamp] = useState<string | null>(
    initialRoute.timestamp,
  );
  const [query, setQuery] = useState("");
  const [recentSearches, setRecentSearches] = useState<string[]>(() => readRecentSearches());
  const [showAddSource, setShowAddSource] = useState(false);
  const [showJobsSheet, setShowJobsSheet] = useState(false);
  const [confirmRequest, setConfirmRequest] = useState<ConfirmRequest | null>(null);
  const [updaterState, setUpdaterState] = useState<DesktopUpdaterState>({ phase: "idle" });
  const [onboardingStep, setOnboardingStep] = useState(0);
  const [settingsSection, setSettingsSection] = useState<string>(() =>
    normalizeSettingsSection(initialRoute.settingsSection),
  );
  const [modelDownloadState, setModelDownloadState] = useState<{
    status: "idle" | "saving_sources" | "downloading" | "error";
    error: string | null;
  }>({ status: "idle", error: null });
  const [onboardingFolders, setOnboardingFolders] = useState<string[]>([]);
  const [onboardingYoutubeChannels, setOnboardingYoutubeChannels] = useState<
    OnboardingYoutubeChannel[]
  >([]);
  const [apiStatus, setApiStatus] = useState<ApiStatus>("connecting");
  const [apiError, setApiError] = useState<string | null>(null);
  const coreLevel = useCoreStatus(apiStatus, apiError);
  const [data, setData] = useState<AppData>({
    sources: [],
    items: [],
    jobs: [],
    settings: {},
    whisperModels: [],
    daemonStatus: null,
    version: null,
  });
  const [liveResults, setLiveResults] = useState<Result[]>([]);
  const [searchDiagnostics, setSearchDiagnostics] = useState<api.SearchDiagnostics | null>(null);
  const [isSearching, setIsSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const lastSearchRef = useRef<{ query: string; retryWhenIdle: boolean } | null>(null);
  // Monotonic token: every runSearch bumps it, stale responses are dropped.
  const searchSeqRef = useRef(0);

  // When the core is offline we keep showing the last data we fetched (or empty
  // states) — never fake content the user might mistake for their own library.
  const visibleSources = data.sources;
  const visibleItems = data.items;
  const visibleResults = liveResults;
  const visibleJobs = apiStatus === "online" ? data.jobs : [];
  // Follow the OS by default — first launch on a light-mode Mac used to open dark.
  const themePreference = settingString(data.settings, "theme", "System");
  // Global indexing pause (the worker skips queued jobs while this is on).
  const indexingPaused = settingBoolean(data.settings, "indexing_paused", false);
  // The Tasks drawer hides orphaned jobs whose item was removed from the
  // library; cancelling a task now keeps the item and marks the job cancelled.
  const drawerJobs = visibleJobs.filter(
    (job) => !job.item_id || data.items.some((item) => item.id === job.item_id),
  );
  const currentItem = visibleItems.find((item) => item.id === selectedItemId) ?? null;
  const activeJobCount = visibleJobs.filter(isActiveJob).length;
  const stepStarts = useStepStarts(visibleJobs);

  // First-run on-device-model consent + download. Fetches capability and shows
  // the dialog once, gated on `local_models_prompted` so it never re-prompts —
  // and never fires before the core's capability route exists, because the
  // capability fetch simply rejects until then.
  const lmTrigger =
    apiStatus === "online" &&
    view !== "onboarding" &&
    !settingBoolean(data.settings, "local_models_prompted", false);
  const lm = useLocalModelConsent({ trigger: lmTrigger, apiOnline: apiStatus === "online" });
  const handleLmAgree = useCallback(() => {
    lm.agree();
    void api
      .updateSettings({ inference_mode: "local", local_models_prompted: true })
      .then(() => refreshCoreData())
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lm.agree]);
  const handleLmDecline = useCallback(() => {
    lm.decline();
    void api
      .updateSettings({ inference_mode: "remote", local_models_prompted: true })
      .then(() => refreshCoreData())
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lm.decline]);
  // Auto-dismiss the "models ready" toast after a few seconds.
  useEffect(() => {
    if (!lm.ready) return;
    const id = window.setTimeout(() => lm.dismissReady(), 6000);
    return () => window.clearTimeout(id);
  }, [lm.ready, lm.dismissReady]);

  // First-run cold start: a packaged app's core takes a few seconds to come up
  // while macOS verifies the bundle. If the user reached the onboarding
  // "core unreachable" error during that window, clear it once the core is
  // online so the step un-sticks on its own (the Start button re-enables too).
  useEffect(() => {
    if (
      apiStatus === "online" &&
      modelDownloadState.status === "error" &&
      modelDownloadState.error === t("common.coreUnreachable")
    ) {
      setModelDownloadState({ status: "idle", error: null });
    }
  }, [apiStatus, modelDownloadState, t]);

  useEffect(() => {
    function handleOAuthRoute(route: RouteState) {
      if (!route.oauthProvider && !route.oauthCode && !route.oauthState && !route.oauthError) {
        return false;
      }
      const settingsRoute = {
        view: "settings" as const,
        itemId: null,
        chunkId: null,
        timestamp: null,
        settingsSection: "Usage",
      };
      setViewState(settingsRoute.view);
      setSelectedItemId(null);
      setSelectedChunkId(null);
      setSelectedTimestamp(null);
      setShowJobsSheet(false);
      setShowAddSource(false);
      setSettingsSection(settingsRoute.settingsSection);
      window.history.replaceState(null, "", `#${routeHash("settings", { settingsSection: "Usage" })}`);
      void persistLastRoute(settingsRoute);

      if (route.oauthError) {
        console.warn("OAuth login failed", route.oauthError);
        return true;
      }
      if (!route.oauthCode || !route.oauthState) {
        console.warn("OAuth login callback was missing code or state");
        return true;
      }
      void exchangeOAuthCode({ code: route.oauthCode, state: route.oauthState }).catch((error) => {
        console.warn("OAuth login exchange failed", error);
      });
      return true;
    }

    function syncHashRoute() {
      const route = readRouteState();
      if (handleOAuthRoute(route)) {
        return;
      }
      setViewState(route.view);
      setSelectedItemId(route.itemId);
      setSelectedChunkId(route.chunkId);
      setSelectedTimestamp(route.timestamp);
      setShowJobsSheet(false);
      setShowAddSource(false);
      const normalizedRoute =
        route.view === "settings"
          ? { ...route, settingsSection: normalizeSettingsSection(route.settingsSection) }
          : route;
      if (normalizedRoute.view === "settings") {
        setSettingsSection(normalizedRoute.settingsSection ?? "General");
      }
      void persistLastRoute(normalizedRoute);
    }

    if (window.location.hash) {
      syncHashRoute();
    }
    window.addEventListener("hashchange", syncHashRoute);
    return () => window.removeEventListener("hashchange", syncHashRoute);
  }, [exchangeOAuthCode]);

  useEffect(() => {
    let cancelled = false;

    loadPersistedUiState()
      .then((state) => {
        if (cancelled) {
          return;
        }

        // First run (a fresh or cleared install): no completed-onboarding flag,
        // no persisted route, and no explicit deep link → open the onboarding
        // intro rather than an empty home. Requiring no persisted route avoids
        // forcing existing users (who predate this flag but have navigated
        // before) back through onboarding on upgrade. The flag is set when the
        // wizard finishes (startIndexingFromOnboarding) or via Settings →
        // "Re-run onboarding".
        if (!state.hasCompletedOnboarding && !state.lastRoute && !window.location.hash) {
          setViewState("onboarding");
          return;
        }

        if (!window.location.hash && state.lastRoute) {
          restorePersistedRoute(state.lastRoute);
        }
      })
      .catch(() => undefined);

    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    void refreshCoreData();
  }, []);

  // Desktop auto-update: subscribe to shell-pushed updater state, sync the
  // current value, and keep background checks sparse. In the browser/fixture
  // harness, ?fakeUpdate=<version> renders the pill without a desktop host so
  // the flow stays reviewable.
  useEffect(() => {
    const fakeVersion = hashQueryParam("fakeUpdate");
    if (fakeVersion) {
      setUpdaterState({
        phase: "available",
        version: fakeVersion,
        releaseUrl: "https://github.com/cerul-ai/cerul-app/releases",
        canAutoInstall: false,
      });
      return;
    }
    if (!hasDesktopHost()) {
      return;
    }
    const unsubscribe = subscribeDesktopUpdater(setUpdaterState);
    let cancelled = false;
    let checkInFlight = false;
    let timeoutId: number | null = null;
    let wakeProbeId: number | null = null;
    let lastWakeProbeAt = Date.now();

    function clearScheduledCheck() {
      if (timeoutId !== null) {
        window.clearTimeout(timeoutId);
        timeoutId = null;
      }
    }

    function scheduleNextDueCheck() {
      if (cancelled) {
        return;
      }
      const delay = nextAutomaticUpdateCheckDelay();
      clearScheduledCheck();
      timeoutId = window.setTimeout(() => void runAutomaticUpdateCheck(), delay);
    }

    function scheduleOfflineRetry() {
      if (cancelled) {
        return;
      }
      clearScheduledCheck();
      timeoutId = window.setTimeout(() => void runAutomaticUpdateCheck(), automaticUpdateOfflineRetryMs);
    }

    async function runAutomaticUpdateCheck() {
      clearScheduledCheck();
      if (cancelled || checkInFlight) {
        return;
      }
      if (window.navigator.onLine === false) {
        scheduleOfflineRetry();
        return;
      }
      if (!automaticUpdateCheckIsDue()) {
        scheduleNextDueCheck();
        return;
      }
      checkInFlight = true;
      try {
        const next = await runDesktopUpdaterCheck();
        if (!cancelled) {
          setUpdaterState(next);
        }
      } catch (error) {
        console.error("desktop updater automatic check failed", error);
      } finally {
        checkInFlight = false;
        writeLastAutomaticUpdateCheckAt(Date.now());
        scheduleNextDueCheck();
      }
    }

    function scheduleDueCheckAfter(delay: number) {
      if (cancelled || !automaticUpdateCheckIsDue()) {
        return;
      }
      clearScheduledCheck();
      timeoutId = window.setTimeout(() => void runAutomaticUpdateCheck(), delay);
    }

    function scheduleResumeCheck() {
      scheduleDueCheckAfter(randomDelay(automaticUpdateResumeDelayRangeMs));
    }

    function handleVisibilityChange() {
      if (document.visibilityState === "visible") {
        scheduleResumeCheck();
      }
    }

    void getDesktopUpdaterState().then(setUpdaterState);
    if (automaticUpdateCheckIsDue()) {
      scheduleDueCheckAfter(randomDelay(automaticUpdateStartupDelayRangeMs));
    } else {
      scheduleNextDueCheck();
    }
    wakeProbeId = window.setInterval(() => {
      const now = Date.now();
      if (now - lastWakeProbeAt > automaticUpdateWakeGapMs) {
        scheduleResumeCheck();
      }
      lastWakeProbeAt = now;
    }, automaticUpdateWakeProbeIntervalMs);
    window.addEventListener("online", scheduleResumeCheck);
    window.addEventListener("focus", scheduleResumeCheck);
    document.addEventListener("visibilitychange", handleVisibilityChange);
    return () => {
      cancelled = true;
      unsubscribe();
      clearScheduledCheck();
      if (wakeProbeId !== null) {
        window.clearInterval(wakeProbeId);
      }
      window.removeEventListener("online", scheduleResumeCheck);
      window.removeEventListener("focus", scheduleResumeCheck);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, []);

  useEffect(() => {
    function handleGlobalKeyDown(event: globalThis.KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "n") {
        // Don't stack a new dialog on top of an open modal or steal the
        // shortcut while the user is typing in a field.
        const target = event.target;
        const inEditable =
          target instanceof HTMLElement &&
          (target.isContentEditable ||
            target.tagName === "INPUT" ||
            target.tagName === "TEXTAREA" ||
            target.tagName === "SELECT");
        if (hasOpenModalSurface() || inEditable) {
          return;
        }
        event.preventDefault();
        setShowAddSource(true);
      }
    }

    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  useEffect(() => {
    const root = document.documentElement;
    const media =
      typeof window.matchMedia === "function"
        ? window.matchMedia("(prefers-color-scheme: light)")
        : null;

    function applyTheme() {
      const resolvedTheme = resolveThemePreference(themePreference, media?.matches ?? false);
      root.dataset.theme = resolvedTheme;
      root.dataset.themePreference = themePreference.toLowerCase();
    }

    applyTheme();
    media?.addEventListener("change", applyTheme);

    return () => {
      media?.removeEventListener("change", applyTheme);
    };
  }, [themePreference]);

  useEffect(() => {
    if (apiStatus !== "online" || activeJobCount === 0) {
      return;
    }

    const intervalId = window.setInterval(() => {
      void refreshCoreData();
    }, 2500);
    return () => window.clearInterval(intervalId);
  }, [apiStatus, activeJobCount]);

  // Items/sources are mapped through t() at fetch time; re-map once when the
  // user switches language so dates/status text don't stay in the old locale.
  const { lang } = useLang();
  const lastMappedLangRef = useRef(lang);
  useEffect(() => {
    if (lastMappedLangRef.current === lang) {
      return;
    }
    lastMappedLangRef.current = lang;
    if (apiStatus === "online") {
      void refreshCoreData();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [lang]);

  // Auto-reconnect: while the core is unreachable, keep probing with a
  // capped exponential backoff instead of waiting for a manual Retry click.
  useEffect(() => {
    if (apiStatus === "online") {
      return;
    }
    let cancelled = false;
    let attempt = 0;
    let timeoutId = 0;

    const probe = () => {
      const delay = Math.min(2000 * 2 ** attempt, 15000);
      attempt += 1;
      timeoutId = window.setTimeout(() => {
        void refreshCoreData().then((result) => {
          if (!cancelled && result === null) probe();
        });
      }, delay);
    };
    probe();

    return () => {
      cancelled = true;
      window.clearTimeout(timeoutId);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [apiStatus]);

  async function refreshCoreData(): Promise<AppData | null> {
    setApiError(null);

    try {
      const [health, sourceRecords, itemRecords, jobRecords, settings, whisperModels, daemonStatus] =
        await Promise.all([
          api.health(),
          api.listSources(),
          api.listItems(),
          api.listJobs(),
          api.listSettings(),
          api.listWhisperModels(),
          readDaemonStatus(),
        ]);
      const mappedItems = itemRecords.map((record) => mapItemRecord(record, jobRecords, t));
      const nextData: AppData = {
        sources: sourceRecords.map((source) => mapSourceRecord(source, mappedItems, t)),
        items: mappedItems,
        jobs: jobRecords,
        settings,
        whisperModels,
        daemonStatus,
        version: health.version,
      };
      setData(nextData);
      setApiStatus("online");
      const pendingRetry = lastSearchRef.current;
      if (pendingRetry?.retryWhenIdle && !jobRecords.some(isActiveJob)) {
        lastSearchRef.current = { query: pendingRetry.query, retryWhenIdle: false };
        const seqAtSchedule = searchSeqRef.current;
        api
          .search(pendingRetry.query, 20)
          .then((response) => {
            // A newer user-initiated search supersedes this idle retry.
            if (seqAtSchedule !== searchSeqRef.current) return;
            setLiveResults(mapSearchResults(response.results, mappedItems, t));
            setSearchDiagnostics(response.diagnostics);
            lastSearchRef.current = {
              query: pendingRetry.query,
              retryWhenIdle: false,
            };
          })
          .catch(() => undefined);
      }
      return nextData;
    } catch (error) {
      setApiStatus((current) => (current === "online" ? "error" : "offline"));
      setApiError(errorMessage(error));
      return null;
    }
  }

  async function restartCoreConnection() {
    setApiStatus("connecting");
    setApiError(null);
    await refreshCoreData();
  }

  function navigate(
    nextView: View,
    params: {
      itemId?: string | null;
      chunkId?: string | null;
      timestamp?: string | null;
      settingsSection?: string | null;
    } = {},
  ) {
    setShowJobsSheet(false);
    setShowAddSource(false);
    setSelectedItemId(params.itemId ?? null);
    setSelectedChunkId(params.chunkId ?? null);
    setSelectedTimestamp(params.timestamp ?? null);
    const routeParams =
      nextView === "settings"
        ? {
            ...params,
            settingsSection:
              params.settingsSection === undefined
                ? params.settingsSection
                : normalizeSettingsSection(params.settingsSection),
          }
        : params;
    if (nextView === "settings" && routeParams.settingsSection) {
      setSettingsSection(routeParams.settingsSection);
    }
    setViewState(nextView);
    const hash = routeHash(nextView, routeParams);
    window.location.hash = hash;
    if ((nextView === "item-detail" || nextView === "result-detail") && routeParams.itemId) {
      recordLastOpened(routeParams.itemId, routeParams.timestamp ?? null);
    }
    void persistLastRoute({
      view: nextView,
      itemId: routeParams.itemId ?? null,
      chunkId: routeParams.chunkId ?? null,
      timestamp: routeParams.timestamp ?? null,
      settingsSection: routeParams.settingsSection ?? null,
    });
  }

  function restorePersistedRoute(route: PersistedRoute) {
    if (!viewIds.includes(route.view as View)) {
      return;
    }

    const restoredView = route.view as View;
    setSelectedItemId(route.itemId ?? null);
    setSelectedChunkId(route.chunkId ?? null);
    setSelectedTimestamp(route.timestamp ?? null);
    const restoredRoute =
      restoredView === "settings"
        ? { ...route, settingsSection: normalizeSettingsSection(route.settingsSection) }
        : route;
    if (restoredView === "settings") {
      setSettingsSection(restoredRoute.settingsSection ?? "General");
    }
    setViewState(restoredView);
    window.location.hash = routeHash(restoredView, restoredRoute);
  }

  function requestConfirm(options: ConfirmOptions) {
    return new Promise<boolean>((resolve) => {
      setConfirmRequest({ ...options, resolve });
    });
  }

  function resolveConfirm(confirmed: boolean) {
    const request = confirmRequest;
    setConfirmRequest(null);
    request?.resolve(confirmed);
  }

  async function handleUpdateActivate() {
    if (updaterState.phase === "available") {
      // No desktop host (browser/preview demo) → just open the download page.
      if (!hasDesktopHost()) {
        window.open(updaterState.releaseUrl, "_blank", "noopener,noreferrer");
        return;
      }
      const next = await downloadDesktopUpdate();
      setUpdaterState(next);
    } else if (updaterState.phase === "downloaded") {
      await installDesktopUpdate();
    } else if (updaterState.phase === "error") {
      window.open(updaterState.releaseUrl, "_blank", "noopener,noreferrer");
    }
  }

  function updateDownloadLabel(state: Extract<DesktopUpdaterState, { phase: "downloading" }>) {
    const speed = formatSpeed(state.bytesPerSecond);
    return speed ? `${state.percent}% · ${speed}` : `${state.percent}%`;
  }

  function updateDownloadTitle(state: Extract<DesktopUpdaterState, { phase: "downloading" }>) {
    const speed = formatSpeed(state.bytesPerSecond);
    const eta = state.etaSeconds != null ? formatDuration(state.etaSeconds, t) : null;
    return [
      t("shell.updateDownloadingTip"),
      `${state.percent}%`,
      speed,
      eta ? t("home.continueRemaining", { remaining: eta }) : null,
    ]
      .filter(Boolean)
      .join(" · ");
  }

  function submitSearch(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const submittedQuery =
      new FormData(event.currentTarget).get("query")?.toString() ??
      event.currentTarget.querySelector<HTMLInputElement>("input")?.value ??
      query;
    setQuery(submittedQuery);
    navigate("results");
    void runSearch(submittedQuery);
  }

  async function runSearch(value: string) {
    const trimmed = value.trim();
    if (!trimmed) {
      setSearchDiagnostics(null);
      return;
    }

    rememberRecentSearch(trimmed);
    const seq = ++searchSeqRef.current;
    const isCurrent = () => seq === searchSeqRef.current;
    setIsSearching(true);
    setSearchError(null);
    setSearchDiagnostics(null);
    try {
      const latestData = await refreshCoreData();
      if (!latestData && apiStatus !== "online") {
        throw new Error(t("common.coreUnreachable"));
      }
      const searchData = latestData ?? data;
      const itemsForResults = searchData.items;
      let retryWhenIndexSettles = searchIndexIsSettling(searchData);
      let response = await api.search(trimmed, 20);
      if (!isCurrent()) return;
      setLiveResults(mapSearchResults(response.results, itemsForResults, t));
      setSearchDiagnostics(response.diagnostics);
      if (response.results.length === 0 || retryWhenIndexSettles) {
        await wait(650);
        if (!isCurrent()) return;
        const refreshed = await refreshCoreData();
        retryWhenIndexSettles = refreshed ? searchIndexIsSettling(refreshed) : retryWhenIndexSettles;
        response = await api.search(trimmed, 20);
        if (!isCurrent()) return;
        setLiveResults(mapSearchResults(response.results, refreshed?.items ?? itemsForResults, t));
        setSearchDiagnostics(response.diagnostics);
      }
      lastSearchRef.current = {
        query: trimmed,
        retryWhenIdle: retryWhenIndexSettles,
      };
    } catch (error) {
      // A failed search is a search-level problem; flipping the whole app
      // into an offline/error state used to swap the UI to demo data.
      if (isCurrent()) setSearchError(errorMessage(error));
    } finally {
      if (isCurrent()) setIsSearching(false);
    }
  }

  function rememberRecentSearch(value: string) {
    setRecentSearches((current) => {
      const normalized = value.trim();
      if (!normalized) {
        return current;
      }
      const next = [normalized, ...current.filter((item) => item !== normalized)].slice(0, 5);
      writeRecentSearches(next);
      return next;
    });
  }

  async function startIndexingFromOnboarding() {
    if (apiStatus !== "online") {
      setModelDownloadState({ status: "error", error: t("common.coreUnreachable") });
      return;
    }

    const folders = uniqueStrings(onboardingFolders);
    const youtubeChannels = uniqueYoutubeChannels(onboardingYoutubeChannels);
    const sourceCount = folders.length + youtubeChannels.length;
    setModelDownloadState({
      status: sourceCount > 0 ? "saving_sources" : "downloading",
      error: null,
    });
    try {
      for (const folder of folders) {
        await api.addSource("folder_video", { path: folder });
      }
      for (const channel of youtubeChannels) {
        await api.addSource("youtube", { url: channel.url, max_videos: 50 });
      }
      setModelDownloadState({ status: "downloading", error: null });
      await api.updateSettings({
        inference_mode: "auto",
        asr_model: "whisper-1",
        active_embedding_profile: "gemini-embedding-2-3072",
      });
      await installDaemon();
      await refreshCoreData();
      setModelDownloadState({ status: "idle", error: null });
      void persistOnboardingCompleted(true);
      navigate("home");
    } catch (error) {
      setModelDownloadState({ status: "error", error: errorMessage(error) });
    }
  }

  const sidebarActiveView = sidebarParentFor[view] ?? view;
  const railItems: { id: View; labelKey: string; icon: LucideIcon }[] = [
    { id: "home", labelKey: "nav.home", icon: Search },
    { id: "library", labelKey: "nav.library", icon: Library },
    { id: "moments", labelKey: "nav.moments", icon: Star },
    { id: "sources", labelKey: "nav.sources", icon: Database },
  ];
  const mobileNavItems = [
    ...railItems,
    { id: "settings" as View, labelKey: "nav.settings", icon: Settings },
  ];
  const mobileTitleKey =
    mobileNavItems.find((item) => item.id === sidebarActiveView)?.labelKey ?? "nav.home";

  return (
    <div className="app" data-onboarding={view === "onboarding" ? "true" : undefined}>
      <div className="titlebar">
        <div className="titlebar-lead">
          {updaterState.phase !== "idle" ? (
            <button
              className={`rail-update is-${updaterState.phase}`}
              type="button"
              disabled={updaterState.phase === "downloading" || updaterState.phase === "installing"}
              title={
                updaterState.phase === "downloading"
                  ? updateDownloadTitle(updaterState)
                  : updaterState.phase === "installing"
                    ? t("shell.updateInstallingTip")
                    : updaterState.phase === "downloaded"
                    ? t("shell.updateReadyTip", { version: updaterState.version })
                    : updaterState.phase === "error"
                    ? t("shell.updateErrorTip", { message: updaterState.message })
                    : t("shell.updateAvailableTip", { version: updaterState.version })
              }
              onClick={() => void handleUpdateActivate()}
            >
              {updaterState.phase === "downloading" ? (
                <>
                  <Loader2 size={13} className="spin" />
                  <span className="rail-update-label">{updateDownloadLabel(updaterState)}</span>
                </>
              ) : updaterState.phase === "installing" ? (
                <>
                  <Loader2 size={13} className="spin" />
                  <span className="rail-update-label">{t("shell.updateInstalling")}</span>
                </>
              ) : updaterState.phase === "downloaded" ? (
                <>
                  <RefreshCcw size={13} />
                  <span className="rail-update-label">{t("shell.updateRestart")}</span>
                </>
              ) : updaterState.phase === "error" ? (
                <>
                  <AlertTriangle size={13} />
                  <span className="rail-update-label">{t("shell.updateError")}</span>
                </>
              ) : (
                <>
                  <Download size={13} />
                  <span className="rail-update-label">{t("shell.update")}</span>
                </>
              )}
            </button>
          ) : null}
        </div>
        <div className="titlebar-drag" aria-hidden="true" />
      </div>
      <aside className="rail">
        <div className="rail-top">
          <button
            className="rail-brand"
            type="button"
            onClick={() => navigate("home")}
            aria-label={t("shell.openHome")}
          >
            <BrandMark />
            <span className="rail-wordmark rail-label">Cerul</span>
          </button>
        </div>

        <nav className="rail-nav" aria-label={t("nav.home")}>
          {railItems.map((item) => {
            const Icon = item.icon;
            return (
              <button
                className={item.id === sidebarActiveView ? "rail-item active" : "rail-item"}
                key={item.id}
                type="button"
                onClick={() => navigate(item.id)}
                title={t(item.labelKey)}
              >
                <span className="rail-ind" aria-hidden="true" />
                <Icon size={17} />
                <span className="rail-label">{t(item.labelKey)}</span>
              </button>
            );
          })}
        </nav>

        <div className="rail-bottom">
          <div className="rail-sep" aria-hidden="true" />
          <button
            className="rail-item"
            type="button"
            onClick={() => setShowJobsSheet(true)}
            title={t("nav.jobs")}
          >
            <span className="rail-ind" aria-hidden="true" />
            <span style={{ position: "relative", display: "inline-flex" }}>
              <ListChecks size={17} />
              {activeJobCount > 0 ? (
                <span className="badge-count" aria-hidden="true">
                  {activeJobCount > 9 ? "9+" : activeJobCount}
                </span>
              ) : null}
            </span>
            <span className="rail-label">{t("nav.jobs")}</span>
          </button>
          <button
            className={sidebarActiveView === "settings" ? "rail-item active" : "rail-item"}
            type="button"
            onClick={() => navigate("settings")}
            title={t("nav.settings")}
          >
            <span className="rail-ind" aria-hidden="true" />
            <Settings size={17} />
            <span className="rail-label">{t("nav.settings")}</span>
          </button>
          <AccountRailButton />
          {lm.minimized && lm.download && lm.download.phase !== "ready" ? (
            <button
              type="button"
              className="rail-dl-pill"
              onClick={lm.reopen}
              title={t("localModel.rail.downloading", { pct: lm.download.overall_progress })}
            >
              <span className="ring" aria-hidden="true" />
              <span className="rail-label clamp1">
                {t("localModel.rail.downloading", { pct: lm.download.overall_progress })}
              </span>
            </button>
          ) : null}
          <div className="rail-status mono">
            <span
              className="rail-status-dot"
              data-level={coreLevel === "grace" ? "ok" : coreLevel}
              aria-hidden="true"
            />
            <span className="rail-label">
              {coreLevel === "ok" || coreLevel === "grace"
                ? t("shell.coreLocal")
                : coreLevel === "starting"
                  ? t("shell.coreStarting")
                  : t("shell.coreUnresponsive")}
            </span>
          </div>
        </div>
      </aside>

      <div className="mobilebar">
        <button
          className="rail-brand"
          type="button"
          onClick={() => navigate("home")}
          aria-label={t("shell.openHome")}
        >
          <BrandMark />
        </button>
        <span className="tb-title clamp1">{t(mobileTitleKey)}</span>
        <button
          className="btn-icon sm"
          type="button"
          onClick={() => setShowJobsSheet(true)}
          aria-label={t("nav.jobs")}
        >
          <span style={{ position: "relative", display: "inline-flex" }}>
            <ListChecks size={17} />
            {activeJobCount > 0 ? (
              <span className="badge-count" aria-hidden="true">
                {activeJobCount > 9 ? "9+" : activeJobCount}
              </span>
            ) : null}
          </span>
        </button>
      </div>

      <main className="content">
        {view === "onboarding" ? (
          <Onboarding
            step={onboardingStep}
            setStep={setOnboardingStep}
            apiStatus={apiStatus}
            folders={onboardingFolders}
            setFolders={setOnboardingFolders}
            youtubeChannels={onboardingYoutubeChannels}
            setYoutubeChannels={setOnboardingYoutubeChannels}
            modelDownloadState={modelDownloadState}
            onDone={startIndexingFromOnboarding}
          />
        ) : null}
        {view === "home" ? (
          <HomeScreen
            query={query}
            setQuery={setQuery}
            onSubmit={submitSearch}
            onAddSource={() => setShowAddSource(true)}
            onOpenItem={(item, timestamp) =>
              navigate("item-detail", { itemId: item.id, timestamp })
            }
            onOpenLibrary={() => navigate("library")}
            items={visibleItems}
            sources={visibleSources}
            jobs={visibleJobs}
            apiStatus={apiStatus}
            onOpenModelSettings={() => navigate("settings", { settingsSection: "Models" })}
            globalHotkey={settingString(data.settings, "global_hotkey", "Alt+Space")}
          />
        ) : null}
        {view === "results" ? (
          <ResultsScreen
            query={query}
            setQuery={setQuery}
            onSubmit={submitSearch}
            onBack={() => navigate("home")}
            onOpen={(result) =>
              navigate("result-detail", {
                itemId: result.itemId,
                chunkId: result.id,
                timestamp: result.timestamp,
              })
            }
            results={visibleResults}
            diagnostics={searchDiagnostics}
            isSearching={isSearching}
            error={searchError}
            apiStatus={apiStatus}
            hasIndexedItems={visibleItems.some((item) => item.status === "indexed")}
            hasActiveJobs={visibleJobs.some(isActiveJob)}
          />
        ) : null}
        {view === "result-detail" && !currentItem ? (
          <div className="screen">
            <EmptyState
              title={t("detail.notFound.title")}
              body={t("detail.notFound.body")}
              actionLabel={t("detail.notFound.back")}
              onAction={() => navigate("library")}
            />
          </div>
        ) : null}
        {view === "result-detail" && currentItem ? (
          <ResultDetail
            item={currentItem}
            startChunkId={selectedChunkId}
            moreMatches={
              visibleResults.find((result) => result.id === selectedChunkId)?.moreMatches
            }
            startTimestamp={selectedTimestamp ?? "00:00"}
            actionsEnabled={apiStatus === "online"}
            onLibrary={() => navigate("results")}
            onDeleteItem={async (itemToDelete) => {
              await api.deleteItem(itemToDelete.id);
              await refreshCoreData();
              navigate("library");
            }}
            onReindexItem={async (itemToReindex) => {
              await api.reindexItem(itemToReindex.id);
              await refreshCoreData();
            }}
            onItemUpdated={async () => {
              await refreshCoreData();
            }}
            requestConfirm={requestConfirm}
          />
        ) : null}
        {view === "library" ? (
          <LibraryScreen
            items={visibleItems}
            jobs={visibleJobs}
            stepStarts={stepStarts}
            actionsEnabled={apiStatus === "online"}
            onAddSource={() => setShowAddSource(true)}
            onOpenJobs={() => setShowJobsSheet(true)}
            onOpenEntity={(entity) => navigate("entity-detail", { itemId: entity.id })}
            onDeleteItems={async (itemIds, onProgress) => {
              const total = itemIds.length;
              let completed = 0;
              onProgress?.(completed, total);
              try {
                for (const itemId of itemIds) {
                  await api.deleteItem(itemId);
                  completed += 1;
                  onProgress?.(completed, total);
                }
                const deletingIds = new Set(itemIds);
                setLiveResults((current) =>
                  current.filter((result) => !deletingIds.has(result.itemId)),
                );
              } finally {
                await refreshCoreData();
              }
            }}
            onReindexItems={async (itemIds) => {
              for (const itemId of itemIds) {
                await api.reindexItem(itemId);
              }
              await refreshCoreData();
            }}
            onOpenItem={(item) => navigate("item-detail", { itemId: item.id })}
            requestConfirm={requestConfirm}
          />
        ) : null}
        {view === "moments" ? (
          <MomentsScreen
            actionsEnabled={apiStatus === "online"}
            onOpenItem={(moment) =>
              navigate("item-detail", { itemId: moment.item_id, timestamp: moment.timestamp })
            }
          />
        ) : null}
        {view === "entity-detail" ? (
          <EntityDetailScreen
            entityId={selectedItemId}
            actionsEnabled={apiStatus === "online"}
            onBack={() => navigate("library")}
            onOpenMention={(mention) =>
              navigate("item-detail", {
                itemId: mention.item_id,
                chunkId: mention.chunk_id,
                timestamp: mention.timestamp,
              })
            }
          />
        ) : null}
        {view === "item-detail" && !currentItem ? (
          <div className="screen">
            <EmptyState
              title={t("detail.notFound.title")}
              body={t("detail.notFound.body")}
              actionLabel={t("detail.notFound.back")}
              onAction={() => navigate("library")}
            />
          </div>
        ) : null}
        {view === "item-detail" && currentItem ? (
          <ItemDetail
            item={currentItem}
            apiStatus={apiStatus}
            actionsEnabled={apiStatus === "online"}
            startTimestamp={selectedTimestamp ?? "0:00"}
            onBack={() => navigate("library")}
            onDeleteItem={async (itemToDelete) => {
              await api.deleteItem(itemToDelete.id);
              await refreshCoreData();
              navigate("library");
            }}
            onReindexItem={async (itemToReindex) => {
              await api.reindexItem(itemToReindex.id);
              await refreshCoreData();
            }}
            onItemUpdated={async () => {
              await refreshCoreData();
            }}
            requestConfirm={requestConfirm}
          />
        ) : null}
        {view === "sources" ? (
          <SourcesScreen
            sources={visibleSources}
            actionsEnabled={apiStatus === "online"}
            onAddSource={() => setShowAddSource(true)}
            onPauseSource={async (source) => {
              await api.pauseSource(source.id);
              await refreshCoreData();
            }}
            onResumeSource={async (source) => {
              await api.resumeSource(source.id);
              await refreshCoreData();
            }}
            onRemoveSource={async (source) => {
              await api.removeSource(source.id);
              await refreshCoreData();
            }}
            onViewItems={() => navigate("library")}
            requestConfirm={requestConfirm}
          />
        ) : null}
        {view === "settings" ? (
          <SettingsScreen
            section={settingsSection}
            setSection={setSettingsSection}
            apiStatus={apiStatus}
            settings={data.settings}
            daemonStatus={data.daemonStatus}
            onSettingsChange={async (settings) => {
              await api.updateSettings(settings);
              await refreshCoreData();
            }}
            requestConfirm={requestConfirm}
          />
        ) : null}
      </main>

      <nav className="bottomnav" aria-label={t("nav.home")}>
        {mobileNavItems.map((item) => {
          const Icon = item.icon;
          return (
            <button
              key={item.id}
              type="button"
              className={item.id === sidebarActiveView ? "active" : ""}
              onClick={() => navigate(item.id)}
            >
              <Icon size={18} />
              <span>{t(item.labelKey)}</span>
            </button>
          );
        })}
      </nav>

      <CoreStatusToast
        show={coreLevel === "unresponsive"}
        error={apiError}
        onAction={restartCoreConnection}
      />

      {showAddSource ? (
        <AddSourceDialog
          onClose={() => setShowAddSource(false)}
          requestConfirm={requestConfirm}
          onAddSource={async (type, config) => {
            await api.addSource(type, config);
            await refreshCoreData();
          }}
        />
      ) : null}
      {showJobsSheet ? (
        <JobsSheet
          jobs={drawerJobs}
          items={visibleItems}
          stepStarts={stepStarts}
          paused={indexingPaused}
          controlsEnabled={apiStatus === "online"}
          onTogglePause={async () => {
            try {
              await api.updateSettings({ indexing_paused: !indexingPaused });
              await refreshCoreData();
            } catch (error) {
              console.warn("failed to toggle indexing pause", error);
            }
          }}
          onCancelJob={async (job) => {
            const confirmed = await requestConfirm({
              title: t("jobs.confirm.cancel.title"),
              body: t("jobs.confirm.cancel.body"),
              confirmLabel: t("jobs.confirm.cancel.confirm"),
            });
            if (!confirmed) {
              return;
            }
            try {
              await api.cancelJob(job.id);
              await refreshCoreData();
            } catch (error) {
              console.warn("failed to cancel job", error);
            }
          }}
          onClose={() => setShowJobsSheet(false)}
          onOpenSettingsFix={(section) => {
            setShowJobsSheet(false);
            navigate("settings", { settingsSection: section });
          }}
          onOpenSources={() => {
            setShowJobsSheet(false);
            navigate("sources");
          }}
        />
      ) : null}
      <ConfirmDialog
        request={confirmRequest}
        onCancel={() => resolveConfirm(false)}
        onConfirm={() => resolveConfirm(true)}
      />
      {lm.show && !lm.minimized ? (
        <LocalModelConsent
          capability={lm.capability}
          download={lm.download}
          paused={lm.paused}
          onAgree={handleLmAgree}
          onDecline={handleLmDecline}
          onPause={lm.pauseDownload}
          onResume={lm.resumeDownload}
          onCancelDownload={lm.cancelDownload}
          onBackground={lm.background}
        />
      ) : null}
      {lm.ready ? (
        <button type="button" className="toast lm-toast" onClick={lm.dismissReady}>
          <Check size={15} />
          <span>{t("localModel.ready.toast")}</span>
        </button>
      ) : null}
    </div>
  );
}

function submitSearchInputOnEnter(event: KeyboardEvent<HTMLInputElement>) {
  if (event.key !== "Enter" || event.nativeEvent.isComposing) {
    return;
  }
  event.preventDefault();
  event.currentTarget.form?.requestSubmit();
}

function formatWeeklyHours(seconds: number) {
  const hours = Math.floor(Math.max(0, seconds) / 3600);
  const minutes = Math.round((Math.max(0, seconds) % 3600) / 60);
  if (hours > 0 && minutes > 0) {
    return `${hours}h ${minutes}m`;
  }
  if (hours > 0) {
    return `${hours}h`;
  }
  return `${minutes}m`;
}

// First-run empty state: an inviting drag zone and the two ways to add a
// source. No placeholder results — the page stays honest until the user's own
// content is indexed.
function HomeEmptyState({ onAddSource }: { onAddSource: () => void }) {
  const t = useT();
  const [dragOver, setDragOver] = useState(false);
  return (
    <div className="page home-empty">
      <div className="home-empty-head">
        <span className="mono-eyebrow">
          <span className="dot" />
          {t("home.emptyHero.eyebrow")}
        </span>
        <h1 className="home-empty-title">{t("home.emptyHero.title")}</h1>
        <p className="home-empty-body">{t("home.emptyHero.body")}</p>
      </div>

      <div
        className={dragOver ? "drag-zone over" : "drag-zone"}
        onDragOver={(event) => {
          event.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={(event) => {
          event.preventDefault();
          setDragOver(false);
          onAddSource();
        }}
      >
        <span className="drag-icon">
          <FolderDown size={22} />
        </span>
        <div className="drag-text">
          <strong>{t("home.emptyHero.dragTitle")}</strong>
          <small>{t("home.emptyHero.dragHint")}</small>
        </div>
        <div className="drag-actions">
          <button className="btn btn-primary" type="button" onClick={onAddSource}>
            <Folder size={16} />
            <span>{t("onboarding.folder.choose")}</span>
          </button>
          <button className="btn btn-secondary" type="button" onClick={onAddSource}>
            <Youtube size={16} />
            <span>{t("home.emptyHero.followYoutube")}</span>
          </button>
        </div>
      </div>
    </div>
  );
}

function HomeScreen({
  query,
  setQuery,
  onSubmit,
  onAddSource,
  onOpenItem,
  onOpenLibrary,
  items,
  sources,
  jobs,
  apiStatus,
  onOpenModelSettings,
  globalHotkey,
}: {
  query: string;
  setQuery: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onAddSource: () => void;
  onOpenItem: (item: Item, timestamp?: string | null) => void;
  onOpenLibrary: () => void;
  items: Item[];
  sources: Source[];
  jobs: api.JobRecord[];
  apiStatus: ApiStatus;
  onOpenModelSettings: () => void;
  globalHotkey: string;
}) {
  const t = useT();
  const indexedCount = items.filter((item) => item.status === "indexed").length;
  const activeSources = sources.filter((source) => source.status === "active").length;
  const activeJobs = jobs.filter(isActiveJob);
  const hasSources = sources.length > 0;
  const searchDisabled = hasSources && indexedCount === 0;
  const runtimeMinutes = Math.round(
    items.reduce((total, item) => total + durationMinutes(item.duration), 0),
  );
  const runtimeHours = Math.floor(runtimeMinutes / 60);
  const runtimeRemainder = runtimeMinutes % 60;
  const recentIndexed = [...items]
    .sort((left, right) => (right.indexedAtEpoch ?? 0) - (left.indexedAtEpoch ?? 0))
    .slice(0, 4);
  const [weeklyReview, setWeeklyReview] = useState<api.WeeklyReview | null>(null);
  // Weekly review is kept but lives off the default home (完整版 baseline has no
  // weekly card) — surfaced on demand via the "本周回顾" toggle in the recent header.
  const [showWeekly, setShowWeekly] = useState(false);
  const serverContinueItem = items
    .filter((item) => item.status === "indexed" && item.playbackPosition?.updated_at)
    .sort(
      (left, right) =>
        (right.playbackPosition?.updated_at ?? 0) - (left.playbackPosition?.updated_at ?? 0),
    )[0];
  const lastOpened = readLastOpened();
  const fallbackContinueItem =
    lastOpened
      ? items.find((item) => item.id === lastOpened.itemId && item.status === "indexed")
      : undefined;
  const fallbackTimestampSec =
    fallbackContinueItem && lastOpened?.timestamp
      ? parseTimestampSeconds(lastOpened.timestamp)
      : Number.NaN;
  const fallbackIsUseful =
    fallbackContinueItem &&
    lastOpened &&
    (!Number.isFinite(fallbackTimestampSec) ||
      !isNearEndPosition(fallbackTimestampSec, fallbackContinueItem.durationSec));
  const serverUpdatedAtMs = (serverContinueItem?.playbackPosition?.updated_at ?? 0) * 1000;
  const preferFallbackContinue =
    Boolean(fallbackIsUseful && lastOpened && (!serverContinueItem || lastOpened.at > serverUpdatedAtMs));
  const continueItem = preferFallbackContinue ? fallbackContinueItem : serverContinueItem;
  const continueTimestamp =
    continueItem?.playbackPosition?.timestamp ??
    (continueItem && lastOpened && continueItem.id === lastOpened.itemId
      ? lastOpened.timestamp
      : null);

  const statusLabel =
    activeJobs.length > 0
      ? t("home.status.indexingJobs", { count: activeJobs.length })
      : apiStatus === "online"
        ? searchDisabled
          ? t("home.status.indexingFirst")
          : t("home.status.indexedCount", { count: indexedCount })
        : coreStatusText(apiStatus, t);

  function handleSearchSubmit(event: FormEvent<HTMLFormElement>) {
    if (searchDisabled) {
      event.preventDefault();
      return;
    }

    onSubmit(event);
  }

  useEffect(() => {
    let cancelled = false;
    if (apiStatus !== "online") {
      return;
    }
    api
      .weeklyReview()
      .then((review) => {
        if (!cancelled) {
          setWeeklyReview(review.has_data ? review : null);
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [apiStatus, indexedCount, activeJobs.length]);

  if (!hasSources && apiStatus === "online") {
    return <HomeEmptyState onAddSource={onAddSource} />;
  }

  return (
    <div className="page home-page" style={{ maxWidth: 920 }}>
      <div className="home-search-stage">
        <h1>{t("home.heading")}</h1>
        <p className="muted home-summary">
          {t("home.summary", {
            count: indexedCount,
            runtime:
              runtimeHours > 0
                ? t("home.runtime.hm", { hours: runtimeHours, minutes: runtimeRemainder })
                : t("home.runtime.m", { minutes: runtimeMinutes || 0 }),
            sources: activeSources,
          })}
        </p>

        <form
          className={searchDisabled ? "search-wrap disabled" : "search-wrap"}
          onSubmit={handleSearchSubmit}
          style={{ width: "100%", maxWidth: 720, marginTop: 28 }}
        >
          <Search size={18} />
          <input
            className="search-input"
            name="query"
            disabled={searchDisabled}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={submitSearchInputOnEnter}
            placeholder={
              searchDisabled ? t("home.searchLockedPlaceholder") : t("home.searchPlaceholder")
            }
            aria-label={t("home.searchAria")}
            aria-describedby={searchDisabled ? "home-search-helper" : undefined}
          />
        </form>
        {searchDisabled ? (
          <p className="field-hint" id="home-search-helper" style={{ marginTop: 10 }}>
            {t("home.lockedHint")}
          </p>
        ) : null}

        <div className="row gap-3 home-status-line">
          {activeJobs.length > 0 ? (
            <span className="chip indexing">
              <Loader2 size={13} className="spin" />
              {statusLabel}
            </span>
          ) : (
            <span className="chip neutral">
              <span className="dot" />
              {statusLabel}
            </span>
          )}
          <span className="faint home-hotkey">{t("home.hotkeyHint", { hotkey: formatHotkeyLabel(globalHotkey) })}</span>
        </div>
      </div>

      {continueItem ? (
        <div className="home-continue-block">
          <div className="home-block-head">
            <p className="section-label">{t("home.continueWatching")}</p>
            <button className="btn btn-ghost sm" type="button" onClick={onAddSource}>
              <Plus size={14} />
              <span>{t("home.addSource")}</span>
            </button>
          </div>
          <ContinueWatchingCard
            item={continueItem}
            timestamp={continueTimestamp}
            onOpen={() => onOpenItem(continueItem, continueTimestamp)}
          />
        </div>
      ) : null}

      <div className="home-recent-block">
        <div className="home-block-head">
          <p className="section-label">{t("home.recentIndexed")}</p>
          <div className="row gap-2">
            {weeklyReview ? (
              <button
                className={showWeekly ? "btn btn-ghost sm active" : "btn btn-ghost sm"}
                type="button"
                onClick={() => setShowWeekly((value) => !value)}
              >
                <Sparkles size={14} />
                <span>{t("weekly.title")}</span>
              </button>
            ) : null}
            <button className="btn btn-ghost sm" type="button" onClick={onOpenLibrary}>
              <span>{t("home.browseLibrary")}</span>
              <ChevronRight size={14} />
            </button>
            {!continueItem ? (
              <button className="btn btn-ghost sm" type="button" onClick={onAddSource}>
                <Plus size={14} />
                <span>{t("home.addSource")}</span>
              </button>
            ) : null}
          </div>
        </div>

        {showWeekly && weeklyReview ? (
          <section className="weekly-card" aria-label={t("weekly.title")}>
            <div>
              <p className="section-label">{t("weekly.eyebrow")}</p>
              <h2>{t("weekly.title")}</h2>
              <p>
                {t("weekly.body", {
                  items: weeklyReview.indexed_items,
                  hours: formatWeeklyHours(weeklyReview.indexed_seconds),
                  watched: weeklyReview.watched_percent,
                })}
              </p>
              {weeklyReview.topics.length > 0 ? (
                <div className="weekly-topics">
                  {weeklyReview.topics.map((topic) => (
                    <span className="chip neutral" key={topic.id}>{topic.label}</span>
                  ))}
                </div>
              ) : null}
            </div>
            <button
              type="button"
              className="btn-icon sm"
              aria-label={t("common.close")}
              onClick={() => setShowWeekly(false)}
            >
              <X size={15} />
            </button>
          </section>
        ) : null}

        {recentIndexed.length > 0 ? (
          <div className="home-recent-grid">
            {recentIndexed.map((item) => (
              <RecentIndexedCard key={item.id} item={item} onOpen={() => onOpenItem(item)} />
            ))}
          </div>
        ) : (
          <EmptyState
            title={t("library.empty.none.title")}
            body={t("library.empty.none.body")}
            actionLabel={t("library.empty.addSource")}
            onAction={onAddSource}
          />
        )}
      </div>
    </div>
  );
}

function ContinueWatchingCard({
  item,
  timestamp,
  onOpen,
}: {
  item: Item;
  timestamp: string | null;
  onOpen: () => void;
}) {
  const t = useT();
  const positionSec = item.playbackPosition?.position_sec ?? null;
  const progressPct =
    positionSec != null && item.durationSec
      ? Math.min(100, Math.max(2, (positionSec / item.durationSec) * 100))
      : null;
  const remaining =
    positionSec != null && item.durationSec
      ? formatDuration(Math.max(0, item.durationSec - positionSec))
      : null;
  const sourceLabel = item.source || t("home.continueLocal");
  return (
    <button className="cw-banner" type="button" onClick={onOpen} title={t("home.continueResume")}>
      {item.thumbnailUrl ? (
        <img className="cw-bg" src={item.thumbnailUrl} alt="" loading="lazy" />
      ) : null}
      <span className="cw-noise" aria-hidden="true" />
      <span className="cw-glow" aria-hidden="true" />
      <span className="cw-scrim" aria-hidden="true" />
      <span className="cw-play" aria-hidden="true">
        <Play size={20} fill="currentColor" />
      </span>
      <span className="cw-badge mono">
        <span className="cw-badge-dot" aria-hidden="true" />
        {sourceLabel}
      </span>
      {item.duration ? <span className="cw-dur mono">{item.duration}</span> : null}
      <span className="cw-bottom">
        <span className="cw-info">
          <strong className="cw-title clamp1">{item.title}</strong>
          <span className="cw-meta">
            {timestamp
              ? `${t("home.continueAt", { at: timestamp, total: item.duration })}${
                  remaining ? ` · ${t("home.continueRemaining", { remaining })}` : ""
                }`
              : itemKindLabel(item, t)}
          </span>
        </span>
        <span className="cw-resume">
          <Play size={13} fill="currentColor" />
          {t("home.continuePlay")}
        </span>
      </span>
      {progressPct != null ? (
        <span className="cw-bar" aria-hidden="true">
          <span style={{ width: `${progressPct}%` }} />
        </span>
      ) : null}
    </button>
  );
}

function RecentIndexedCard({ item, onOpen }: { item: Item; onOpen: () => void }) {
  const t = useT();
  return (
    <button className="card hover lib-card recent-indexed-card" type="button" onClick={onOpen}>
      <span className={`thumb ${item.thumbnailUrl ? "has-image" : item.color}`}>
        {item.thumbnailUrl ? (
          <img src={item.thumbnailUrl} alt="" loading="lazy" />
        ) : (
          <ItemModalityIcon item={item} size={20} />
        )}
        {item.contentType !== "image" && item.duration ? (
          <small className="thumb-duration mono">{item.duration}</small>
        ) : null}
      </span>
      <span className="body">
        <strong className="clamp2">{item.title}</strong>
        <span className="recent-card-meta muted">
          {item.contentType !== "video" ? <ItemModalityIcon item={item} size={13} /> : null}
          <span>
            {item.indexedAtEpoch === null
              ? t("library.itemCard.notIndexed")
              : t("library.itemCard.indexedAt", { when: item.indexedAt })}
          </span>
        </span>
        {item.visualIndexStatus === "failed" ? (
          <span className="item-warning chip warn">
            <span className="dot" />
            {t("library.itemCard.transcriptOnly")}
          </span>
        ) : null}
        {item.embeddingIndexStatus === "failed" ? (
          <span className="item-warning chip warn">
            <span className="dot" />
            {t("library.itemCard.partialIndex")}
          </span>
        ) : null}
      </span>
    </button>
  );
}

function ResultsScreen({
  query,
  setQuery,
  onSubmit,
  onBack,
  onOpen,
  results,
  diagnostics,
  isSearching,
  error,
  apiStatus,
  hasIndexedItems,
  hasActiveJobs,
}: {
  query: string;
  setQuery: (value: string) => void;
  onSubmit: (event: FormEvent<HTMLFormElement>) => void;
  onBack: () => void;
  onOpen: (result: Result) => void;
  results: Result[];
  diagnostics: api.SearchDiagnostics | null;
  isSearching: boolean;
  error: string | null;
  apiStatus: ApiStatus;
  hasIndexedItems: boolean;
  hasActiveJobs: boolean;
}) {
  const t = useT();
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [expandedResultIds, setExpandedResultIds] = useState<Set<string>>(() => new Set());
  const [modalityFilter, setModalityFilter] = useState<ResultModalityFilter>("all");
  const [sortMode, setSortMode] = useState<"relevance" | "recent">("relevance");
  const filtersActive =
    modalityFilter !== "all" || sortMode !== "relevance";
  const filteredResults = results.filter((result) => {
    const matchesModality = modalityFilter === "all" || resultModality(result) === modalityFilter;
    return matchesModality;
  });
  const displayedResults =
    sortMode === "recent"
      ? [...filteredResults].sort(
          (left, right) =>
            (right.indexedAtEpoch ?? 0) - (left.indexedAtEpoch ?? 0) ||
            right.score - left.score,
        )
      : filteredResults;
  const modalityCounts = {
    all: results.length,
    audio: results.filter((result) => resultModality(result) === "audio").length,
    image: results.filter((result) => resultModality(result) === "image").length,
    video: results.filter((result) => resultModality(result) === "video").length,
  };
  const hasQuery = query.trim().length > 0;
  const hasSearched = hasQuery || results.length > 0;
  const diagnosticsText = diagnostics ? searchDiagnosticsSummary(diagnostics, t) : null;
  const diagnosticsTitle = diagnostics ? searchDiagnosticsTitle(diagnostics) : undefined;

  useEffect(() => {
    setSelectedIndex(0);
    setExpandedResultIds(new Set());
  }, [query, results.length, modalityFilter, sortMode]);

  function focusResult(index: number) {
    window.requestAnimationFrame(() => {
      document.querySelector<HTMLElement>(`[data-result-index="${index}"]`)?.focus();
    });
  }

  function clearResultFilters() {
    setModalityFilter("all");
    setSortMode("relevance");
  }

  function handleResultsKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (!displayedResults.length) {
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key === "ArrowDown") {
      event.preventDefault();
      const selectedResult = displayedResults[Math.min(selectedIndex, displayedResults.length - 1)];
      if (selectedResult.moreMatches.length > 0) {
        setExpandedResultIds((current) => {
          const next = new Set(current);
          if (next.has(selectedResult.id)) {
            next.delete(selectedResult.id);
          } else {
            next.add(selectedResult.id);
          }
          return next;
        });
      }
      return;
    }

    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const direction = event.key === "ArrowDown" ? 1 : -1;
      const nextIndex = (selectedIndex + direction + displayedResults.length) % displayedResults.length;
      setSelectedIndex(nextIndex);
      focusResult(nextIndex);
    }

    if (event.key === "Enter" && event.target === event.currentTarget) {
      event.preventDefault();
      onOpen(displayedResults[Math.min(selectedIndex, displayedResults.length - 1)]);
    }
  }

  return (
    <>
      <div className="topbar">
        <div className="tb-inner">
          <button className="btn-icon" type="button" onClick={onBack} aria-label={t("results.backHome")}>
            <ChevronRight size={16} style={{ transform: "rotate(180deg)" }} />
          </button>
          <form className="search-wrap" onSubmit={onSubmit} style={{ flex: 1, maxWidth: 480 }}>
            <Search size={16} style={{ left: 12, width: 16, height: 16 }} />
            <input
              className="input"
              name="query"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={submitSearchInputOnEnter}
              placeholder={t("results.searchPlaceholder")}
              aria-label={t("results.searchAria")}
              style={{ height: 38, paddingLeft: 38 }}
            />
          </form>
          <span className="muted mono" style={{ fontSize: 12, marginLeft: "auto" }}>
            {t("results.status.hits", { count: displayedResults.length })}
          </span>
        </div>
      </div>

      <div className="page">
        <div className="row results-filter-row">
          <div className="segmented" aria-label={t("results.modeTabs.aria")}>
            <button
              type="button"
              className={modalityFilter === "all" ? "active" : ""}
              onClick={() => setModalityFilter("all")}
            >
              {t("results.modeTabs.all")} <span className="chip neutral">{modalityCounts.all}</span>
            </button>
            <button
              type="button"
              className={modalityFilter === "video" ? "active" : ""}
              onClick={() => setModalityFilter("video")}
            >
              {t("results.modeTabs.video")} <span className="chip neutral">{modalityCounts.video}</span>
            </button>
            <button
              type="button"
              className={modalityFilter === "image" ? "active" : ""}
              onClick={() => setModalityFilter("image")}
            >
              {t("results.modeTabs.shown")} <span className="chip neutral">{modalityCounts.image}</span>
            </button>
            <button
              type="button"
              className={modalityFilter === "audio" ? "active" : ""}
              onClick={() => setModalityFilter("audio")}
            >
              {t("results.modeTabs.audio")} <span className="chip neutral">{modalityCounts.audio}</span>
            </button>
          </div>
          <div className="row gap-2">
            <span className="muted" style={{ fontSize: 12.5 }}>{t("results.sort.label")}</span>
            <div className="segmented">
              <button
                type="button"
                className={sortMode === "relevance" ? "active" : ""}
                onClick={() => setSortMode("relevance")}
              >
                {t("results.sort.relevance")}
              </button>
              <button
                type="button"
                className={sortMode === "recent" ? "active" : ""}
                onClick={() => setSortMode("recent")}
              >
                {t("results.sort.recent")}
              </button>
            </div>
          </div>
        </div>

        {error ? (
          <div className="state danger" role="alert" style={{ marginTop: 12 }}>
            <div className="state-icon">
              <AlertTriangle size={18} />
            </div>
            <div className="state-sub">{error}</div>
          </div>
        ) : null}
        {apiStatus !== "online" ? (
          <p className="field-hint" style={{ marginTop: 10 }}>
            {t("results.notice.demo")}
          </p>
        ) : null}
        {hasSearched && !isSearching ? (
          <div className="row" style={{ alignItems: "center", gap: 10, marginTop: 12 }}>
            <span className="muted">
              {t("results.summary.count", {
                count: displayedResults.length,
                total: results.length,
              })}
            </span>
            {filtersActive ? (
              <button type="button" className="btn btn-ghost sm" onClick={clearResultFilters}>
                {t("common.clearFilters")}
              </button>
            ) : null}
          </div>
        ) : null}
        {diagnosticsText ? (
          <p className="field-hint" style={{ marginTop: 6 }} title={diagnosticsTitle}>
            {diagnosticsText}
          </p>
        ) : null}

        <div
          className={displayedResults.length > 0 || isSearching ? "card results-card-list" : "results-card-list"}
          tabIndex={displayedResults.length ? 0 : undefined}
          onKeyDown={handleResultsKeyDown}
          aria-label={t("results.list.aria")}
        >
          {isSearching ? <ResultsSkeletonList /> : null}
          {!isSearching && displayedResults.length > 0
            ? displayedResults.map((result, index) => (
              <ResultCard
                key={result.id}
                result={result}
                index={index}
                selected={index === selectedIndex}
                expanded={expandedResultIds.has(result.id)}
                onFocus={() => setSelectedIndex(index)}
                onOpen={onOpen}
                query={query}
              />
            ))
            : null}
          {!isSearching && displayedResults.length === 0 ? (
            !hasSearched ? (
              <EmptyState
                title={t("results.empty.initial.title")}
                body={t("results.empty.initial.body")}
              />
            ) : (
              <EmptyState
                title={
                  results.length > 0 && filtersActive
                    ? t("results.empty.filtered.title")
                    : !hasIndexedItems && hasActiveJobs
                      ? t("results.empty.indexing.title")
                      : t("results.empty.none.title")
                }
                body={
                  results.length > 0 && filtersActive
                    ? t("results.empty.filtered.body")
                    : !hasIndexedItems && hasActiveJobs
                      ? t("results.empty.indexing.body")
                      : t("results.empty.none.body")
                }
              />
            )
          ) : null}
        </div>
      </div>
    </>
  );
}

function ResultsSkeletonList() {
  return (
    <>
      {[0, 1, 2].map((index) => (
        <div className="result-row result-skeleton" key={index} aria-hidden="true">
          <span className="sk" style={{ width: 132, height: 74, borderRadius: "var(--r-md)" }} />
          <span className="col gap-2" style={{ paddingTop: 4 }}>
            <span className="sk" style={{ height: 13, width: "70%" }} />
            <span className="sk" style={{ height: 11, width: "92%" }} />
            <span className="sk" style={{ height: 11, width: "55%" }} />
          </span>
          <span className="sk" style={{ height: 11, width: 44 }} />
        </div>
      ))}
    </>
  );
}

function parseTimeToSeconds(time: string): number {
  const parts = time.split(":").map((part) => Number.parseInt(part, 10) || 0);
  if (parts.length === 3) return parts[0] * 3600 + parts[1] * 60 + parts[2];
  if (parts.length === 2) return parts[0] * 60 + parts[1];
  return parts[0] ?? 0;
}

function secondsToSrtTimestamp(total: number): string {
  const pad = (value: number, width = 2) =>
    String(Math.max(0, Math.floor(value))).padStart(width, "0");
  return `${pad(total / 3600)}:${pad((total % 3600) / 60)}:${pad(total % 60)},000`;
}

function transcriptToSrt(lines: TranscriptLine[]): string {
  return lines
    .map((line, index) => {
      const start = parseTimeToSeconds(line.time);
      const nextStart =
        index + 1 < lines.length ? parseTimeToSeconds(lines[index + 1].time) : start + 3;
      const end = Math.max(nextStart, start + 1);
      return `${index + 1}\n${secondsToSrtTimestamp(start)} --> ${secondsToSrtTimestamp(end)}\n${line.text}`;
    })
    .join("\n\n");
}

function transcriptToMarkdown(title: string, lines: TranscriptLine[]): string {
  const body = lines.map((line) => `**[${line.time}]** ${line.text}`).join("\n\n");
  return `# ${title}\n\n${body}\n`;
}

function transcriptFilenameBase(title: string): string {
  const cleaned = title.replace(/[^\p{L}\p{N}\-_ ]/gu, "").trim().slice(0, 60);
  return cleaned || "transcript";
}

function downloadTextFile(filename: string, content: string, mime: string) {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 0);
}


// Overflow menu in the detail header: whole-transcript exports plus the
// lower-frequency maintenance actions (re-index, delete). Primary actions
// (copy citation, open source, export clip) stay as visible buttons.
function DetailActionsMenu({
  onExportMarkdown,
  onExportSrt,
  onReindex,
  onDelete,
  busy = false,
  reindexing = false,
  deleting = false,
}: {
  onExportMarkdown?: () => void;
  onExportSrt?: () => void;
  onReindex: () => void;
  onDelete: () => void;
  busy?: boolean;
  reindexing?: boolean;
  deleting?: boolean;
}) {
  const t = useT();
  const ref = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(false);
  useEscapeToClose(() => setOpen(false), open);
  useClickOutside(ref, () => setOpen(false), open);
  const run = (fn: () => void) => {
    setOpen(false);
    fn();
  };
  return (
    <div className="row-actions" ref={ref}>
      <button
        className="btn-icon"
        type="button"
        aria-label={t("detail.moreActions")}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <MoreHorizontal size={16} />
      </button>
      {open ? (
        <div className="menu row-menu" role="menu">
          {onExportMarkdown ? (
            <button type="button" onClick={() => run(onExportMarkdown)}>
              <Download size={15} />
              <span>{t("detail.action.exportMarkdown")}</span>
            </button>
          ) : null}
          {onExportSrt ? (
            <button type="button" onClick={() => run(onExportSrt)}>
              <Download size={15} />
              <span>{t("detail.action.exportSrt")}</span>
            </button>
          ) : null}
          <button type="button" disabled={busy} onClick={() => run(onReindex)}>
            {reindexing ? <Loader2 size={15} className="spin" /> : <RefreshCcw size={15} />}
            <span>{reindexing ? t("common.reindexing") : t("common.reindex")}</span>
          </button>
          <span className="msep" />
          <button className="danger" type="button" disabled={busy} onClick={() => run(onDelete)}>
            {deleting ? <Loader2 size={15} className="spin" /> : <Trash2 size={15} />}
            <span>{deleting ? t("common.deleting") : t("common.delete")}</span>
          </button>
        </div>
      ) : null}
    </div>
  );
}

function useItemMoments(item: Item, enabled: boolean) {
  const [moments, setMoments] = useState<api.MomentRecord[]>([]);
  const [pendingLineId, setPendingLineId] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);

  const reload = useCallback(async () => {
    if (!enabled) {
      setMoments([]);
      return;
    }
    const records = await api.listMoments();
    setMoments(records.filter((moment) => moment.item_id === item.id));
  }, [enabled, item.id]);

  useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      setMoments([]);
      return;
    }
    api
      .listMoments()
      .then((records) => {
        if (!cancelled) {
          setMoments(records.filter((moment) => moment.item_id === item.id));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [enabled, item.id]);

  // Indexed lookups: the per-line linear scan made transcript rendering
  // O(lines x moments).
  const momentIndex = useMemo(() => {
    const byChunk = new Map<string, api.MomentRecord>();
    const byQuote = new Map<string, api.MomentRecord>();
    for (const moment of moments) {
      if (moment.chunk_id) byChunk.set(moment.chunk_id, moment);
      byQuote.set(`${moment.timestamp}\u0000${moment.quote.trim()}`, moment);
    }
    return { byChunk, byQuote };
  }, [moments]);

  function momentForLine(line: TranscriptLine) {
    return (
      momentIndex.byChunk.get(line.id) ??
      momentIndex.byQuote.get(`${line.time}\u0000${line.text.trim()}`)
    );
  }

  async function toggle(line: TranscriptLine) {
    if (!enabled || pendingLineId) {
      return;
    }
    setPendingLineId(line.id);
    setMessage(null);
    try {
      const existing = momentForLine(line);
      if (existing) {
        await api.deleteMoment(existing.id);
      } else {
        const startSec = parseTimestampSeconds(line.time);
        await api.createMoment({
          item_id: item.id,
          chunk_id: line.id,
          start_sec: Number.isFinite(startSec) ? startSec : null,
          title: item.title,
          quote: line.text,
        });
      }
      await reload();
    } catch (error) {
      setMessage(errorMessage(error));
    } finally {
      setPendingLineId(null);
    }
  }

  return {
    moments,
    pendingLineId,
    message,
    momentForLine,
    toggle,
  };
}

function MomentLineAction({
  saved,
  pending,
  disabled,
  onToggle,
}: {
  saved: boolean;
  pending: boolean;
  disabled: boolean;
  onToggle: () => void;
}) {
  const t = useT();
  return (
    <button
      type="button"
      className={saved ? "moment-star saved" : "moment-star"}
      disabled={disabled || pending}
      title={saved ? t("moments.unsave") : t("moments.save")}
      aria-label={saved ? t("moments.unsave") : t("moments.save")}
      onClick={onToggle}
    >
      {pending ? <Loader2 size={14} /> : <Star size={14} fill={saved ? "currentColor" : "none"} />}
    </button>
  );
}

function TranscriptReadingView({
  title,
  lines,
  onSeek,
}: {
  title: string;
  lines: TranscriptLine[];
  onSeek?: (timestamp: string) => void;
}) {
  return (
    <article className="transcript-reading">
      <h2 className="reading-title">{title}</h2>
      {lines.map((line) => (
        <p key={line.id} className="reading-para">
          <button
            type="button"
            className="reading-ts mono"
            onClick={() => onSeek?.(line.time)}
            aria-label={line.time}
          >
            {line.time}
          </button>
          <span>{line.text}</span>
        </p>
      ))}
    </article>
  );
}

function searchDiagnosticsSummary(diagnostics: api.SearchDiagnostics, t: TFunction) {
  const base = t("results.diagnostics.summary", {
    mode: searchRetrievalModeLabel(diagnostics.retrieval_mode, t),
    vector: diagnostics.vector_hits_count,
    fts: diagnostics.fts_hits_count,
  });
  if (!diagnostics.fallback_reason) {
    return base;
  }
  return `${base} · ${t("results.diagnostics.reason", {
    reason: searchFallbackReasonLabel(diagnostics.fallback_reason, t),
  })}`;
}

function searchRetrievalModeLabel(mode: string, t: TFunction) {
  switch (mode) {
    case "hybrid":
      return t("results.diagnostics.mode.hybrid");
    case "vector":
      return t("results.diagnostics.mode.vector");
    case "fts":
      return t("results.diagnostics.mode.fts");
    case "fts_fallback":
      return t("results.diagnostics.mode.ftsFallback");
    case "empty":
      return t("results.diagnostics.mode.empty");
    default:
      return mode;
  }
}

function searchFallbackReasonLabel(reason: string, t: TFunction) {
  switch (reason) {
    case "embedding_unavailable":
    case "query_embedding_failed":
      return t("results.diagnostics.reason.queryEmbeddingFailed");
    case "query_embedding_task_failed":
      return t("results.diagnostics.reason.queryEmbeddingTaskFailed");
    case "query_embedding_timeout":
      return t("results.diagnostics.reason.queryEmbeddingTimeout");
    case "vector_search_failed":
      return t("results.diagnostics.reason.vectorSearchFailed");
    case "vector_index_empty":
      return t("results.diagnostics.reason.vectorIndexEmpty");
    case "no_vector_hits":
      return t("results.diagnostics.reason.noVectorHits");
    case "qdrant_health_check_failed":
      return t("results.diagnostics.reason.qdrantHealthCheckFailed");
    default:
      return reason;
  }
}

function searchDiagnosticsTitle(diagnostics: api.SearchDiagnostics) {
  return [
    `profile=${diagnostics.embedding_profile_id ?? "-"}`,
    `text_collection=${diagnostics.qdrant_text_collection ?? "-"}`,
    `image_collection=${diagnostics.qdrant_image_collection ?? "-"}`,
    `text_points=${diagnostics.qdrant_text_points ?? "-"}`,
    `image_points=${diagnostics.qdrant_image_points ?? "-"}`,
  ].join(" ");
}

function ResultDetail({
  item,
  startChunkId,
  startTimestamp,
  moreMatches,
  actionsEnabled,
  onLibrary,
  onDeleteItem,
  onReindexItem,
  onItemUpdated,
  requestConfirm,
}: {
  item: Item;
  startChunkId: string | null;
  startTimestamp: string;
  moreMatches?: ResultMatch[];
  actionsEnabled: boolean;
  onLibrary: () => void;
  onDeleteItem: (item: Item) => Promise<void>;
  onReindexItem: (item: Item) => Promise<void>;
  onItemUpdated: () => Promise<void>;
  requestConfirm: RequestConfirm;
}) {
  const t = useT();
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const [currentTimestamp, setCurrentTimestamp] = useState(startTimestamp);
  const [isPlaying, setIsPlaying] = useState(true);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playerChapters, setPlayerChapters] = useState<PlayerChapter[]>([]);
  const handleUnderstandingChapters = useCallback((chapters: api.VideoUnderstandingChapter[]) => {
    setPlayerChapters(
      chapters
        .filter((chapter) => chapter.start_sec !== null)
        .map((chapter) => ({ seconds: chapter.start_sec as number, title: chapter.title })),
    );
  }, []);
  const shouldAutoPlayRef = useRef(true);
  const [mediaState, setMediaState] = useState<{
    status: "idle" | "loading" | "ready" | "error";
    chunkId: string | null;
    lines: TranscriptLine[];
    message: string | null;
  }>({ status: "idle", chunkId: null, lines: transcript, message: null });
  const [itemAction, setItemAction] = useState<{
    status: "idle" | "locating" | "reindexing" | "deleting" | "queued" | "error";
    message: string | null;
  }>({ status: "idle", message: null });
  const [readingMode, setReadingMode] = useState(false);
  const detailIssue = itemDetailIssue(item, t);
  const transcriptLines =
    actionsEnabled && mediaState.status !== "idle" ? mediaState.lines : transcript;
  const momentActions = useItemMoments(item, actionsEnabled && mediaState.status === "ready");
  const playbackUrl =
    item.contentType === "video" && mediaState.chunkId
      ? api.videoSegmentUrl(mediaState.chunkId)
      : null;
  const timestampLink = timestampDeepLink(item.id, currentTimestamp);
  const transcriptPartial = item.status === "indexing";
  const itemBusy =
    itemAction.status === "locating" ||
    itemAction.status === "reindexing" ||
    itemAction.status === "deleting";
  // Resolve the chunk to clip from the LIVE playhead at the moment the export
  // popover opens — not the stale currentTimestamp (which only moves on
  // explicit seeks). Fixes clips/filenames always anchoring at 0:00.
  function resolveClipTarget(): ClipTarget | null {
    const video = videoRef.current;
    // Use the live playhead once the video has actually moved; before that,
    // fall back to the timestamp the screen opened at.
    const liveSec =
      video && Number.isFinite(video.currentTime) && video.currentTime > 0.1
        ? video.currentTime
        : parseTimestampSeconds(currentTimestamp);
    return resolveClipTarget_(transcriptLines, liveSec);
  }
  // Real sibling search hits for this item (passed down from the results
  // list). The previous implementation showed arbitrary transcript lines
  // labelled as "other matches".
  const otherMatches = (moreMatches ?? [])
    .map((match) => match.timestamp)
    .filter((timestamp) => timestamp !== startTimestamp)
    .slice(0, 3);
  const playerMarkers: PlayerMarker[] = useMemo(
    () =>
      transcriptLines
        .map((line) => ({
          seconds: parseTimestampSeconds(line.time),
          label: line.time,
          text: line.text,
          match: line.time === startTimestamp,
        }))
        .filter((marker) => Number.isFinite(marker.seconds) && marker.seconds >= 0),
    [transcriptLines, startTimestamp],
  );

  usePlaybackPositionPersistence({
    itemId: item.id,
    videoRef,
    chunkId: mediaState.chunkId,
    enabled: actionsEnabled && Boolean(playbackUrl),
  });

  useEffect(() => {
    setCurrentTimestamp(startTimestamp);
    setIsPlaying(true);
    setItemAction({ status: "idle", message: null });
  }, [item.id, startTimestamp]);

  useEffect(() => {
    if (!actionsEnabled) {
      setMediaState({ status: "idle", chunkId: null, lines: transcript, message: null });
      return;
    }

    let cancelled = false;
    setMediaState({ status: "loading", chunkId: startChunkId, lines: [], message: null });
    api
      .listItemChunks(item.id)
      .then((records) => {
        if (cancelled) {
          return;
        }
        setMediaState({
          status: "ready",
          chunkId: selectPlaybackChunkId(records, startTimestamp, startChunkId),
          lines: mapChunkRecords(records),
          message: null,
        });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setMediaState({
          status: "error",
          chunkId: startChunkId,
          lines: [],
          message: errorMessage(error),
        });
      });

    return () => {
      cancelled = true;
    };
  }, [actionsEnabled, item.id, startChunkId, startTimestamp]);

  useEffect(() => {
    shouldAutoPlayRef.current = isPlaying;
  }, [isPlaying]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playbackUrl) {
      return;
    }

    let cancelled = false;
    const targetSeconds = parseTimestampSeconds(currentTimestamp);
    const syncVideo = () => {
      if (cancelled) {
        return;
      }
      if (Number.isFinite(targetSeconds)) {
        const maxTime = Number.isFinite(video.duration)
          ? Math.max(video.duration - 0.1, 0)
          : targetSeconds;
        video.currentTime = Math.min(targetSeconds, maxTime);
      }
      if (shouldAutoPlayRef.current) {
        void video.play().catch(() => {
          if (!cancelled) {
            setIsPlaying(false);
          }
        });
      }
    };

    if (video.readyState >= 1) {
      syncVideo();
    } else {
      video.addEventListener("loadedmetadata", syncVideo, { once: true });
    }

    return () => {
      cancelled = true;
      video.removeEventListener("loadedmetadata", syncVideo);
    };
  }, [currentTimestamp, playbackUrl]);

  useEffect(() => {
    if (copyStatus === "idle") {
      return;
    }

    const timeout = window.setTimeout(() => setCopyStatus("idle"), 1600);
    return () => window.clearTimeout(timeout);
  }, [copyStatus]);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (hasOpenModalSurface()) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onLibrary();
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "BUTTON" ||
          target.tagName === "A" ||
          target.tagName === "SELECT" ||
          target.tagName === "VIDEO" ||
          target.isContentEditable ||
          target.getAttribute("role") === "button")
      ) {
        return;
      }
      const video = videoRef.current;
      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        if (video) {
          if (video.paused) {
            void video.play().catch(() => undefined);
          } else {
            video.pause();
          }
        } else {
          setIsPlaying((playing) => !playing);
        }
        return;
      }
      if (!video) {
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        video.currentTime = Math.min(video.duration || Number.POSITIVE_INFINITY, video.currentTime + 5);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 5);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        video.volume = Math.min(1, video.volume + 0.1);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        video.volume = Math.max(0, video.volume - 0.1);
      } else if (event.key.toLowerCase() === "m") {
        video.muted = !video.muted;
      } else if (event.key.toLowerCase() === "f") {
        if (document.fullscreenElement) {
          void document.exitFullscreen().catch(() => undefined);
        } else if (video.requestFullscreen) {
          void video.requestFullscreen().catch(() => undefined);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onLibrary]);

  async function copyTimestampLink() {
    try {
      const quote = transcriptLines.find((line) => line.time === currentTimestamp)?.text;
      const citation = buildMomentCitation({
        title: item.title,
        timestamp: currentTimestamp,
        quote,
        link: item.originalUrl ?? timestampLink,
      });
      await writeClipboardText(citation);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
  }

  function seekTo(timestamp: string) {
    setCurrentTimestamp(timestamp);
    setIsPlaying(true);
    const targetSeconds = parseTimestampSeconds(timestamp);
    const nearestLine = transcriptLines
      .filter((line) => Number.isFinite(parseTimestampSeconds(line.time)))
      .sort(
        (left, right) =>
          Math.abs(parseTimestampSeconds(left.time) - targetSeconds) -
          Math.abs(parseTimestampSeconds(right.time) - targetSeconds),
      )[0];
    if (nearestLine) {
      setMediaState((current) => ({ ...current, chunkId: nearestLine.id }));
    }
  }

  async function locateSourceFile() {
    setItemAction({ status: "locating", message: null });
    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "Video", extensions: ["mp4", "mkv", "webm", "mov", "m4v"] }],
    }).catch(() => null);
    if (typeof selected === "string" && selected.trim()) {
      try {
        await api.updateItemRawPath(item.id, selected.trim());
        await onItemUpdated();
        setItemAction({
          status: "idle",
          message: t("detail.locatedSource", { path: selected }),
        });
      } catch (error) {
        setItemAction({ status: "error", message: errorMessage(error) });
      }
      return;
    }
    setItemAction({ status: "idle", message: null });
  }

  async function openOriginalSource() {
    if (!canOpenOriginalSource(item)) {
      return;
    }
    if (!item.originalUrl) {
      setItemAction({ status: "locating", message: null });
    }
    try {
      const message = await openOriginalSourceForItem(item, t);
      if (!item.originalUrl) {
        setItemAction({ status: "queued", message });
      }
    } catch (error) {
      setItemAction({ status: "error", message: errorMessage(error) });
    }
  }

  async function reindexCurrentItem() {
    if (!actionsEnabled) {
      setItemAction({ status: "error", message: t("common.coreUnreachable") });
      return;
    }

    const confirmed = await requestConfirm({
      title: t("common.confirm.reindex.title"),
      body: t("common.confirm.reindex.body"),
      confirmLabel: t("common.reindex"),
    });
    if (!confirmed) {
      return;
    }

    setItemAction({ status: "reindexing", message: null });
    try {
      await onReindexItem(item);
      setItemAction({ status: "queued", message: t("common.reindexQueued") });
    } catch (error) {
      setItemAction({ status: "error", message: errorMessage(error) });
    }
  }

  async function deleteCurrentItem() {
    if (!actionsEnabled) {
      setItemAction({ status: "error", message: t("common.coreUnreachable") });
      return;
    }
    const confirmed = await requestConfirm({
      title: t("common.confirm.delete.title"),
      body: t("common.confirm.delete.body", { title: item.title }),
      confirmLabel: t("common.delete"),
    });
    if (!confirmed) {
      return;
    }

    setItemAction({ status: "deleting", message: null });
    try {
      await onDeleteItem(item);
    } catch (error) {
      setItemAction({ status: "error", message: errorMessage(error) });
    }
  }

  return (
    <div className="detail-view">
      <div className="topbar">
        <div className="tb-inner" style={{ maxWidth: 1180 }}>
          <button className="btn-icon" type="button" onClick={onLibrary} aria-label={t("detail.backToResults")}>
            <ChevronRight size={16} style={{ transform: "rotate(180deg)" }} />
          </button>
          <span className="tb-title clamp1">{item.title}</span>
          <div className="row gap-2" style={{ marginLeft: "auto" }}>
            <button className="btn btn-ghost sm" type="button" onClick={copyTimestampLink}>
              {copyStatus === "copied" ? <Check size={15} /> : <Copy size={15} />}
              <span>{copyStatus === "copied" ? t("detail.copy.copied") : t("detail.copy.label")}</span>
            </button>
            <button
              className="btn btn-secondary sm"
              type="button"
              disabled={!canOpenOriginalSource(item) || itemBusy}
              onClick={() => void openOriginalSource()}
            >
              {item.originalUrl ? <ExternalLink size={15} /> : <Folder size={15} />}
              <span>{item.originalUrl ? t("detail.source.openOriginal") : t("detail.source.reveal")}</span>
            </button>
            <ClipExportButton
              contentType={item.contentType}
              disabled={itemBusy}
              resolveTarget={resolveClipTarget}
            />
            <DetailActionsMenu
              onExportMarkdown={
                transcriptLines.length > 0
                  ? () =>
                      downloadTextFile(
                        `${transcriptFilenameBase(item.title)}.md`,
                        transcriptToMarkdown(item.title, transcriptLines),
                        "text/markdown;charset=utf-8",
                      )
                  : undefined
              }
              onExportSrt={
                transcriptLines.length > 0
                  ? () =>
                      downloadTextFile(
                        `${transcriptFilenameBase(item.title)}.srt`,
                        transcriptToSrt(transcriptLines),
                        "text/plain;charset=utf-8",
                      )
                  : undefined
              }
              onReindex={() => void reindexCurrentItem()}
              onDelete={() => void deleteCurrentItem()}
              busy={itemBusy}
              reindexing={itemAction.status === "reindexing"}
              deleting={itemAction.status === "deleting"}
            />
          </div>
        </div>
      </div>

      <div className="page" style={{ maxWidth: 1180 }}>
        <div className="detail-split">
          <div className="detail-media">
            <div className="row gap-2" style={{ marginBottom: 12, flexWrap: "wrap" }}>
              <span className="chip neutral">{item.source}</span>
              <span className={item.indexedAtEpoch === null ? "chip neutral" : "chip success"}>
                <span className="dot" />
                {item.indexedAtEpoch === null ? t("detail.notIndexed") : t("detail.indexedAt", { when: item.indexedAt })}
              </span>
              <span className="mono faint" style={{ fontSize: 12 }}>{item.duration}</span>
            </div>
            {detailIssue ? (
              <div className="detail-media-issue">
                <DetailIssuePanel
                  issue={detailIssue}
                  actionStatus={itemAction.status}
                  actionsEnabled={actionsEnabled}
                  hasOriginalUrl={Boolean(item.originalUrl)}
                  onLocate={() => void locateSourceFile()}
                  onOpenOriginal={() => void openOriginalSource()}
                  onReindex={() => void reindexCurrentItem()}
                  onRemove={() => void deleteCurrentItem()}
                />
              </div>
            ) : playbackUrl ? (
              <CerulPlayer
                videoRef={videoRef}
                src={playbackUrl}
                markers={playerMarkers}
                chapters={playerChapters}
                ariaLabel={t("itemDetail.player.aria", { title: item.title })}
                fallbackDurationSec={item.durationSec}
                onPlay={() => setIsPlaying(true)}
                onPause={() => setIsPlaying(false)}
                onSeekMarker={(marker) => seekTo(marker.label)}
              />
            ) : mediaState.status === "loading" ? (
              <div className={`video-frame thumb ${item.color}`}>
                <div className="stripes" aria-hidden="true" />
                <div className="player-loading" role="status">
                  <Loader2 size={24} />
                  <span>{t("detail.player.preparing")}</span>
                </div>
              </div>
            ) : (
              <div className={`video-frame thumb ${item.color}`}>
                <div className="stripes" aria-hidden="true" />
                <div className="player-placeholder">
                  <button
                    className="play-button"
                    type="button"
                    aria-label={isPlaying ? t("detail.player.pauseAria") : t("detail.player.playAria")}
                    onClick={() => setIsPlaying((playing) => !playing)}
                  >
                    {isPlaying ? <Pause size={22} fill="currentColor" /> : <Play size={22} fill="currentColor" />}
                  </button>
                </div>
              </div>
            )}

            {/* Header now owns copy/open-source/export-clip + the ⋯ menu
                (export Markdown/SRT, re-index, delete). The old flat action
                row that used to live here was removed in the detail-actions
                redesign. */}
            <VideoUnderstandingPanel
              item={item}
              enabled={actionsEnabled}
              onSeek={seekTo}
              requestConfirm={requestConfirm}
              onChapters={handleUnderstandingChapters}
            />
          </div>

          <div className="detail-transcript">
            <div className="row" style={{ justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
              <div>
                <p className="section-label" style={{ marginBottom: 2 }}>{t("detail.transcript.eyebrow")}</p>
                <span className="faint mono" style={{ fontSize: 12 }}>{t("detail.transcript.chunkCount", { count: transcriptLines.length })}</span>
              </div>
              <div className="row gap-2" style={{ alignItems: "center" }}>
                {otherMatches.length > 0 && !readingMode ? (
                  <div className="row gap-1" aria-label={t("detail.otherMatches")}>
                    <span className="faint" style={{ fontSize: 12 }}>
                      {t("detail.otherMatches")}
                    </span>
                    {otherMatches.map((timestamp) => (
                      <button
                        key={timestamp}
                        type="button"
                        className={timestamp === currentTimestamp ? "chip accent" : "chip neutral"}
                        onClick={() => seekTo(timestamp)}
                      >
                        {timestamp}
                      </button>
                    ))}
                  </div>
                ) : null}
                <button
                  type="button"
                  className="btn btn-ghost sm"
                  aria-pressed={readingMode}
                  onClick={() => setReadingMode((on) => !on)}
                >
                  <span>{readingMode ? t("detail.transcriptMode") : t("detail.readingMode")}</span>
                </button>
              </div>
            </div>

            {copyStatus === "error" ? <InlineNotice tone="error" message={t("detail.copy.error")} /> : null}
            {copyStatus === "copied" ? <InlineNotice tone="muted" message={t("detail.copy.success")} /> : null}
            {momentActions.message ? <InlineNotice tone="error" message={momentActions.message} /> : null}
            {itemAction.message ? (
              <InlineNotice
                tone={itemAction.status === "error" ? "error" : "muted"}
                message={itemAction.message}
              />
            ) : null}
            {transcriptPartial ? <InlineNotice tone="muted" message={t("detail.stillProcessing")} /> : null}
            {item.visualIndexMessage ? <InlineNotice tone="muted" message={item.visualIndexMessage} /> : null}
            {item.embeddingIndexMessage ? <InlineNotice tone="muted" message={item.embeddingIndexMessage} /> : null}
            {mediaState.status === "loading" ? <TranscriptSkeleton /> : null}
            {mediaState.status === "error" && mediaState.message ? (
              <InlineNotice tone="error" message={mediaState.message} />
            ) : null}
            {readingMode ? (
              <TranscriptReadingView title={item.title} lines={transcriptLines} onSeek={seekTo} />
            ) : (
              <TranscriptList
                lines={transcriptLines}
                videoRef={videoRef}
                videoReady={Boolean(playbackUrl)}
                activeTime={currentTimestamp}
                matchTime={startTimestamp}
                onSeek={seekTo}
                renderAction={(line) => {
                  const saved = Boolean(momentActions.momentForLine(line));
                  return (
                    <MomentLineAction
                      saved={saved}
                      pending={momentActions.pendingLineId === line.id}
                      disabled={!actionsEnabled}
                      onToggle={() => void momentActions.toggle(line)}
                    />
                  );
                }}
              />
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function VideoUnderstandingPanel({
  item,
  enabled,
  onSeek,
  requestConfirm,
  onChapters,
}: {
  item: Item;
  enabled: boolean;
  onSeek?: (timestamp: string) => void;
  requestConfirm: RequestConfirm;
  onChapters?: (chapters: api.VideoUnderstandingChapter[]) => void;
}) {
  const t = useT();
  const [state, setState] = useState<{
    status: "idle" | "loading" | "analyzing" | "loaded" | "error";
    record: api.VideoUnderstandingRecord | null;
    message: string | null;
  }>({
    status: "idle",
    record: null,
    message: null,
  });
  // Tracks the currently displayed item so long-running requests started
  // for a previous item can detect they are stale.
  const itemIdRef = useRef(item.id);
  itemIdRef.current = item.id;
  const record = state.record;
  const isPending = state.status === "loading" || state.status === "analyzing";
  // Elapsed timer for the analyze run. The request is a single blocking call
  // (upload → Gemini processing → generate) with no server-side progress, so an
  // indeterminate bar + elapsed clock is the honest signal that work is ongoing.
  const [analyzeElapsedMs, setAnalyzeElapsedMs] = useState(0);

  useEffect(() => {
    if (!enabled || item.contentType !== "video") {
      setState({ status: "idle", record: null, message: null });
      return;
    }

    let cancelled = false;
    setState({ status: "loading", record: null, message: null });
    api
      .getItemUnderstanding(item.id)
      .then((next) => {
        if (!cancelled) {
          setState({ status: "loaded", record: next, message: null });
        }
      })
      .catch(() => {
        // A missing/unavailable understanding record is not a hard error for
        // this secondary panel — fall back to the "not analyzed" empty state
        // instead of flashing a red notice. Explicit Analyze failures below
        // still surface their message.
        if (!cancelled) {
          setState({ status: "idle", record: null, message: null });
        }
      });

    return () => {
      cancelled = true;
    };
  }, [enabled, item.contentType, item.id]);

  // Surface chapters to the host so the player can segment its timeline.
  useEffect(() => {
    onChapters?.(record?.chapters ?? []);
  }, [record, onChapters]);

  useEffect(() => {
    if (state.status !== "analyzing") {
      setAnalyzeElapsedMs(0);
      return;
    }
    const startedAt = performance.now();
    const interval = window.setInterval(() => {
      setAnalyzeElapsedMs(performance.now() - startedAt);
    }, 500);
    return () => window.clearInterval(interval);
  }, [state.status]);

  if (item.contentType !== "video") {
    return null;
  }

  async function analyze() {
    if (!enabled || isPending) {
      return;
    }
    const confirmed = await requestConfirm({
      title: t("understanding.confirm.title"),
      body: t("understanding.confirm.body"),
      confirmLabel: t("understanding.confirm.label"),
    });
    if (!confirmed) {
      return;
    }
    // The analyze POST can run for minutes while the panel stays mounted
    // across item switches; pin the id so a finished analysis for item A
    // can't be written into item B's panel (and its player chapters).
    const analyzedItemId = item.id;
    const isCurrent = () => analyzedItemId === itemIdRef.current;
    setState((current) => ({
      status: "analyzing",
      record: current.record,
      message: null,
    }));
    try {
      const next = await api.analyzeItemUnderstanding(analyzedItemId);
      if (!isCurrent()) return;
      setState({ status: "loaded", record: next, message: null });
    } catch (error) {
      if (!isCurrent()) return;
      setState((current) => ({
        status: "error",
        record: current.record,
        message: errorMessage(error),
      }));
    }
  }

  const analysisStatus = record?.status ?? "not_started";
  const statusLabel =
    state.status === "loading"
      ? t("understanding.status.loading")
      : state.status === "analyzing"
        ? t("understanding.status.analyzing")
        : analysisStatus === "completed"
          ? t("understanding.status.analyzed")
          : analysisStatus === "failed"
            ? t("understanding.status.failed")
            : t("understanding.status.notAnalyzed");
  const statusChipClass =
    analysisStatus === "completed"
      ? "chip success"
      : analysisStatus === "failed"
        ? "chip danger"
        : state.status === "analyzing" || state.status === "loading"
          ? "chip accent"
          : "chip neutral";
  const summary = record?.summary?.trim() ?? "";
  const chapters = record?.chapters ?? [];
  const events = record?.events ?? [];
  const topics = record?.topics ?? [];
  const canAnalyze = enabled && !isPending;
  const privacyNote = t("understanding.privacyNote");

  return (
    <section className={`understanding-panel ${analysisStatus}`}>
      <div className="understanding-header">
        <div>
          <p className="section-label" style={{ marginBottom: 2 }}>{t("understanding.eyebrow")}</p>
          <strong>{t("understanding.title")}</strong>
        </div>
        <span className={statusChipClass}>
          <span className="dot" />
          {statusLabel}
        </span>
      </div>

      {state.message ? <InlineNotice tone="error" message={state.message} /> : null}
      {record?.error && analysisStatus === "failed" ? (
        <InlineNotice tone="error" message={record.error} />
      ) : null}

      {state.status === "analyzing" ? (
        <div className="understanding-progress" role="status" aria-live="polite">
          <div className="understanding-progress-track" aria-hidden="true">
            <span className="understanding-progress-fill" />
          </div>
          <div className="understanding-progress-meta">
            <span>{t("understanding.status.analyzing")}</span>
            <span className="mono faint">{formatTimestamp(Math.round(analyzeElapsedMs / 1000))}</span>
          </div>
          <p className="field-hint">{t("understanding.progress.hint")}</p>
        </div>
      ) : null}

      {summary ? (
        <p className="understanding-summary">{summary}</p>
      ) : state.status === "loading" ? (
        <div className="understanding-skeleton" aria-hidden="true">
          <span className="sk" />
          <span className="sk" />
        </div>
      ) : (
        <p className="field-hint">{t("understanding.empty")}</p>
      )}

      {topics.length > 0 ? (
        <div className="understanding-topics" aria-label={t("understanding.topics.aria")}>
          {topics.slice(0, 8).map((topic) => (
            <span key={topic} className="chip neutral">{topic}</span>
          ))}
        </div>
      ) : null}

      <p className="field-hint">{privacyNote}</p>

      {chapters.length > 0 ? (
        <div className="understanding-list">
          <strong>{t("understanding.chapters")}</strong>
          {chapters.slice(0, 4).map((chapter, index) => (
            <button
              className="understanding-row"
              key={`${chapter.title}-${index}`}
              type="button"
              disabled={!onSeek}
              onClick={() => onSeek?.(formatTimestamp(chapter.start_sec))}
            >
              <span className="kbd">{formatTimestamp(chapter.start_sec)}</span>
              <p>
                <b>{chapter.title}</b>
                {chapter.summary ? ` ${chapter.summary}` : ""}
              </p>
            </button>
          ))}
        </div>
      ) : null}

      {events.length > 0 ? (
        <div className="understanding-list">
          <strong>{t("understanding.keyMoments")}</strong>
          {events.slice(0, 5).map((event, index) => (
            <button
              className="understanding-row"
              key={`${event.caption}-${index}`}
              type="button"
              disabled={!onSeek}
              onClick={() => onSeek?.(formatTimestamp(event.start_sec))}
            >
              <span className="kbd">{formatTimestamp(event.start_sec)}</span>
              <p>
                {event.caption}
                {typeof event.confidence === "number"
                  ? ` · ${Math.round(event.confidence * 100)}%`
                  : ""}
              </p>
            </button>
          ))}
        </div>
      ) : null}

      <button
        type="button"
        className="btn btn-primary sm understanding-action"
        disabled={!canAnalyze}
        onClick={() => void analyze()}
      >
        {isPending ? <Loader2 size={15} /> : <Sparkles size={15} />}
        <span>
          {isPending
            ? t("understanding.status.analyzing")
            : analysisStatus === "completed"
              ? t("understanding.action.reanalyze")
              : t("understanding.action.analyze")}
        </span>
      </button>
    </section>
  );
}

async function openOriginalSourceForItem(item: Item, t: TFunction) {
  if (item.originalUrl) {
    window.open(item.originalUrl, "_blank", "noopener,noreferrer");
    return t("detail.source.opened");
  }
  if (item.rawPath) {
    await revealSourcePath(item.rawPath);
    return t("detail.source.revealed");
  }
  throw new Error(t("detail.source.unavailable"));
}

async function writeClipboardText(text: string) {
  if (navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "");
  textarea.style.position = "fixed";
  textarea.style.opacity = "0";
  document.body.appendChild(textarea);
  textarea.select();
  const copied = document.execCommand("copy");
  document.body.removeChild(textarea);

  if (!copied) {
    throw new Error("clipboard copy failed");
  }
}

function MomentsScreen({
  actionsEnabled,
  onOpenItem,
}: {
  actionsEnabled: boolean;
  onOpenItem: (moment: api.MomentRecord) => void;
}) {
  const t = useT();
  const [moments, setMoments] = useState<api.MomentRecord[]>([]);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");

  // Same 1.6s reset as the detail view; the button used to stay "Copied"
  // forever, giving no feedback on subsequent copies.
  useEffect(() => {
    if (copyStatus === "idle") {
      return;
    }
    const timeout = window.setTimeout(() => setCopyStatus("idle"), 1600);
    return () => window.clearTimeout(timeout);
  }, [copyStatus]);

  const load = useCallback(async () => {
    if (!actionsEnabled) {
      setStatus("ready");
      setMoments([]);
      return;
    }
    setStatus("loading");
    setMessage(null);
    try {
      setMoments(await api.listMoments());
      setStatus("ready");
    } catch (error) {
      setMessage(errorMessage(error));
      setStatus("error");
    }
  }, [actionsEnabled]);

  useEffect(() => {
    void load();
  }, [load]);

  async function remove(moment: api.MomentRecord) {
    try {
      await api.deleteMoment(moment.id);
      await load();
    } catch (error) {
      setMessage(errorMessage(error));
    }
  }

  async function copyMarkdown() {
    const markdown = moments
      .map((moment) => `- [${moment.timestamp}] ${moment.quote}\n  - ${moment.title}`)
      .join("\n");
    try {
      await writeClipboardText(markdown);
      setCopyStatus("copied");
    } catch {
      setCopyStatus("error");
    }
  }

  return (
    <div className="page wide">
      <div className="page-head row" style={{ alignItems: "flex-end", justifyContent: "space-between" }}>
        <div>
          <p className="page-eyebrow">{t("moments.eyebrow")}</p>
          <h1 className="page-h1">{t("moments.heading")}</h1>
          <p className="page-sub">{t("moments.sub")}</p>
        </div>
        <button
          type="button"
          className="btn btn-secondary sm"
          disabled={moments.length === 0}
          onClick={() => void copyMarkdown()}
        >
          <Copy size={15} />
          <span>{copyStatus === "copied" ? t("detail.copy.copied") : t("moments.copyMarkdown")}</span>
        </button>
      </div>
      {message ? <InlineNotice tone={status === "error" ? "error" : "muted"} message={message} /> : null}
      {copyStatus === "error" ? <InlineNotice tone="error" message={t("detail.copy.error")} /> : null}
      {status === "loading" ? (
        <div className="state"><Loader2 size={22} /><span>{t("common.loading")}</span></div>
      ) : null}
      {status !== "loading" && moments.length === 0 ? (
        <EmptyState
          title={t("moments.empty.title")}
          body={t("moments.empty.body")}
        />
      ) : null}
      {moments.length > 0 ? (
        <div className="moments-list">
          {moments.map((moment) => (
            <article className="moment-card" key={moment.id}>
              <button type="button" className="moment-card__main" onClick={() => onOpenItem(moment)}>
                <span className="mono moment-card__time">{moment.timestamp}</span>
                <strong>{moment.title}</strong>
                <p>{moment.quote}</p>
              </button>
              <button
                type="button"
                className="btn-icon sm"
                aria-label={t("moments.unsave")}
                onClick={() => void remove(moment)}
              >
                <Trash2 size={15} />
              </button>
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function EntityDetailScreen({
  entityId,
  actionsEnabled,
  onBack,
  onOpenMention,
}: {
  entityId: string | null;
  actionsEnabled: boolean;
  onBack: () => void;
  onOpenMention: (mention: api.EntityMention) => void;
}) {
  const t = useT();
  const [detail, setDetail] = useState<api.EntityDetail | null>(null);
  const [status, setStatus] = useState<"loading" | "ready" | "error">("loading");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!actionsEnabled || !entityId) {
      setStatus("ready");
      setDetail(null);
      return;
    }
    setStatus("loading");
    setMessage(null);
    api
      .getEntity(entityId)
      .then((next) => {
        if (!cancelled) {
          setDetail(next);
          setStatus("ready");
        }
      })
      .catch((error) => {
        if (!cancelled) {
          setMessage(errorMessage(error));
          setStatus("error");
        }
      });
    return () => {
      cancelled = true;
    };
  }, [actionsEnabled, entityId]);

  return (
    <div className="page wide">
      <div className="page-head">
        <button className="btn btn-ghost sm" type="button" onClick={onBack}>
          <ChevronRight size={15} style={{ transform: "rotate(180deg)" }} />
          <span>{t("library.heading")}</span>
        </button>
        <p className="page-eyebrow" style={{ marginTop: 18 }}>{t("entities.eyebrow")}</p>
        <h1 className="page-h1">{detail?.entity.label ?? t("entities.heading")}</h1>
        {detail ? (
          <p className="page-sub">
            {t("entities.detail.sub", {
              count: detail.entity.mention_count,
              items: detail.entity.item_count,
            })}
          </p>
        ) : null}
      </div>
      {message ? <InlineNotice tone="error" message={message} /> : null}
      {status === "loading" ? (
        <div className="state"><Loader2 size={22} /><span>{t("common.loading")}</span></div>
      ) : null}
      {status !== "loading" && !detail ? (
        <EmptyState title={t("entities.empty.title")} body={t("entities.empty.body")} />
      ) : null}
      {detail ? (
        <div className="entity-mentions">
          {detail.mentions.map((mention) => (
            <button
              key={`${mention.item_id}-${mention.chunk_id ?? mention.timestamp}`}
              type="button"
              className="entity-mention"
              onClick={() => onOpenMention(mention)}
            >
              <span className="mono entity-mention__time">{mention.timestamp}</span>
              <strong>{mention.item_title}</strong>
              <p>{mention.quote}</p>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function LibraryScreen({
  items,
  jobs,
  stepStarts,
  actionsEnabled,
  onAddSource,
  onDeleteItems,
  onReindexItems,
  onOpenItem,
  onOpenEntity,
  onOpenJobs,
  requestConfirm,
}: {
  items: Item[];
  jobs: api.JobRecord[];
  stepStarts: Record<string, number>;
  actionsEnabled: boolean;
  onAddSource: () => void;
  onDeleteItems: (
    itemIds: string[],
    onProgress?: (completed: number, total: number) => void,
  ) => Promise<void>;
  onReindexItems: (itemIds: string[]) => Promise<void>;
  onOpenItem: (item: Item) => void;
  onOpenEntity: (entity: api.EntitySummary) => void;
  onOpenJobs: () => void;
  requestConfirm: RequestConfirm;
}) {
  const t = useT();
  const [libraryQuery, setLibraryQuery] = useState("");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [statusFilter, setStatusFilter] = useState("all");
  const [sortKey, setSortKey] = useState<"recent" | "longest" | "shortest" | "title">("recent");
  const [viewMode, setViewMode] = useState<"grid" | "list">("grid");
  const [selectedItemIds, setSelectedItemIds] = useState<Set<string>>(new Set());
  const [batchState, setBatchState] = useState<{
    status: "idle" | "reindexing" | "deleting" | "error";
    message: string | null;
  }>({ status: "idle", message: null });
  const [entities, setEntities] = useState<api.EntitySummary[]>([]);
  const sourceOptions = Array.from(new Set(items.map((item) => item.source))).sort((a, b) =>
    a.localeCompare(b),
  );
  const normalizedQuery = libraryQuery.trim().toLowerCase();
  const filtersActive =
    normalizedQuery !== "" ||
    sourceFilter !== "all" ||
    statusFilter !== "all" ||
    sortKey !== "recent";
  const filteredItems = items
    .filter((item) => {
      const matchesQuery =
        normalizedQuery === "" ||
        item.title.toLowerCase().includes(normalizedQuery) ||
        item.source.toLowerCase().includes(normalizedQuery);
      const matchesSource = sourceFilter === "all" || item.source === sourceFilter;
      const matchesStatus = statusFilter === "all" || item.status === statusFilter;
      return matchesQuery && matchesSource && matchesStatus;
    })
    .sort((a, b) => sortLibraryItems(a, b, sortKey));
  const selectedCount = selectedItemIds.size;
  const filteredItemIds = filteredItems.map((item) => item.id);
  const visibleSelectedCount = filteredItemIds.filter((itemId) => selectedItemIds.has(itemId)).length;
  const allFilteredSelected = filteredItemIds.length > 0 && visibleSelectedCount === filteredItemIds.length;
  const batchPending = batchState.status === "reindexing" || batchState.status === "deleting";

  useEffect(() => {
    const itemIds = new Set(items.map((item) => item.id));
    setSelectedItemIds((current) => {
      const next = new Set(Array.from(current).filter((itemId) => itemIds.has(itemId)));
      return next.size === current.size ? current : next;
    });
  }, [items]);

  useEffect(() => {
    let cancelled = false;
    if (!actionsEnabled) {
      setEntities([]);
      return;
    }
    api
      .listEntities()
      .then((records) => {
        if (!cancelled) {
          setEntities(records.slice(0, 10));
        }
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [actionsEnabled, items.length]);

  function clearLibraryFilters() {
    setLibraryQuery("");
    setSourceFilter("all");
    setStatusFilter("all");
    setSortKey("recent");
  }

  function toggleItemSelection(itemId: string, selected: boolean) {
    setBatchState({ status: "idle", message: null });
    setSelectedItemIds((current) => {
      const next = new Set(current);
      if (selected) {
        next.add(itemId);
      } else {
        next.delete(itemId);
      }
      return next;
    });
  }

  function toggleAllFilteredItems() {
    setBatchState({ status: "idle", message: null });
    setSelectedItemIds((current) => {
      const next = new Set(current);
      if (allFilteredSelected) {
        for (const itemId of filteredItemIds) {
          next.delete(itemId);
        }
      } else {
        for (const itemId of filteredItemIds) {
          next.add(itemId);
        }
      }
      return next;
    });
  }

  async function runBatchAction(action: "reindex" | "delete") {
    if (!actionsEnabled) {
      setBatchState({
        status: "error",
        message: t("common.coreUnreachable"),
      });
      return;
    }

    const itemIds = Array.from(selectedItemIds);
    if (itemIds.length === 0) {
      return;
    }
    if (action === "delete") {
      const confirmed = await requestConfirm({
        title: t("library.batch.confirm.title"),
        body: t("library.batch.confirm.body", { count: itemIds.length }),
        confirmLabel: t("library.batch.confirm.label"),
      });
      if (!confirmed) {
        return;
      }
    }

    setBatchState({
      status: action === "delete" ? "deleting" : "reindexing",
      message:
        action === "delete"
          ? t("library.batch.deletingProgress", { completed: 0, total: itemIds.length })
          : null,
    });
    try {
      if (action === "delete") {
        await onDeleteItems(itemIds, (completed, total) => {
          setBatchState({
            status: "deleting",
            message: t("library.batch.deletingProgress", { completed, total }),
          });
        });
      } else {
        await onReindexItems(itemIds);
      }
      setSelectedItemIds(new Set());
      setBatchState({ status: "idle", message: null });
    } catch (error) {
      setBatchState({ status: "error", message: errorMessage(error) });
    }
  }

  return (
    <div className="page wide">
      <div className="page-head row" style={{ alignItems: "flex-end", justifyContent: "space-between" }}>
        <div>
          <h1 className="page-h1">{t("library.heading")}</h1>
          <p className="page-sub" style={{ maxWidth: 520 }}>{t("library.sub")}</p>
        </div>
        <div className="row gap-2" style={{ alignItems: "center" }}>
          <div className="segmented" aria-label={t("library.view.aria")}>
            <button
              className={viewMode === "grid" ? "active" : ""}
              type="button"
              aria-label={t("library.view.grid")}
              aria-pressed={viewMode === "grid"}
              onClick={() => setViewMode("grid")}
            >
              <Library size={15} />
              <span>{t("library.view.gridShort")}</span>
            </button>
            <button
              className={viewMode === "list" ? "active" : ""}
              type="button"
              aria-label={t("library.view.list")}
              aria-pressed={viewMode === "list"}
              onClick={() => setViewMode("list")}
            >
              <ListFilter size={15} />
              <span>{t("library.view.listShort")}</span>
            </button>
          </div>
          <button className="btn btn-primary" type="button" onClick={onAddSource}>
            <Plus size={16} />
            <span>{t("home.addSource")}</span>
          </button>
        </div>
      </div>
      <IndexingStrip jobs={jobs} items={items} stepStarts={stepStarts} onOpen={onOpenJobs} />
      <div className="row gap-2 library-filter-row" style={{ flexWrap: "wrap", alignItems: "center" }}>
        <div className="search-wrap" style={{ flex: "1 1 240px" }}>
          <Search size={17} />
          <input
            className="search-input"
            value={libraryQuery}
            placeholder={t("library.searchPlaceholder")}
            onChange={(event) => setLibraryQuery(event.currentTarget.value)}
          />
        </div>
        <select
          className="select"
          aria-label={t("library.filter.sourceAria")}
          value={sourceFilter}
          onChange={(event) => setSourceFilter(event.currentTarget.value)}
        >
          <option value="all">{t("library.filter.allSources")}</option>
          {sourceOptions.map((source) => (
            <option key={source} value={source}>
              {source}
            </option>
          ))}
        </select>
        <select
          className="select"
          aria-label={t("library.filter.statusAria")}
          value={statusFilter}
          onChange={(event) => setStatusFilter(event.currentTarget.value)}
        >
          <option value="all">{t("library.filter.allStatuses")}</option>
          <option value="indexed">{t("library.status.indexed")}</option>
          <option value="indexing">{t("library.status.indexing")}</option>
          <option value="failed">{t("library.status.failed")}</option>
        </select>
        <select
          className="select"
          aria-label={t("library.sort.aria")}
          value={sortKey}
          onChange={(event) =>
            setSortKey(event.currentTarget.value as "recent" | "longest" | "shortest" | "title")
          }
        >
          <option value="recent">{t("library.sort.recent")}</option>
          <option value="longest">{t("library.sort.longest")}</option>
          <option value="shortest">{t("library.sort.shortest")}</option>
          <option value="title">{t("library.sort.title")}</option>
        </select>
      </div>
      <div className="row" style={{ alignItems: "center", gap: 10, marginTop: 12 }}>
        <span className="muted">
          {t("library.summary.count", { count: filteredItems.length, total: items.length })}
        </span>
        {filtersActive ? (
          <button type="button" className="btn btn-ghost sm" onClick={clearLibraryFilters}>
            {t("common.clearFilters")}
          </button>
        ) : null}
        {filteredItems.length > 0 ? (
          <button
            type="button"
            className="btn btn-ghost sm library-select-all"
            disabled={batchPending}
            onClick={toggleAllFilteredItems}
          >
            <Check size={14} />
            <span>
              {allFilteredSelected
                ? t("library.batch.selectNone")
                : t("library.batch.selectAll")}
            </span>
          </button>
        ) : null}
      </div>
      {entities.length > 0 ? (
        <div className="entity-chip-row" aria-label={t("entities.eyebrow")}>
          {entities.map((entity) => (
            <button
              key={entity.id}
              type="button"
              className="entity-chip"
              onClick={() => onOpenEntity(entity)}
            >
              <CircleDot size={12} />
              <span>{entity.label}</span>
              <small className="mono">{entity.mention_count}</small>
            </button>
          ))}
        </div>
      ) : null}
      {batchState.message ? (
        <InlineNotice
          tone={batchState.status === "error" ? "error" : "muted"}
          message={batchState.message}
        />
      ) : null}
      {selectedCount > 0 ? (
        <div
          className="card pad row gap-2"
          aria-label={t("library.batch.aria")}
          style={{ alignItems: "center", position: "sticky", top: 12, zIndex: 5, marginTop: 12 }}
        >
          <span className="chip accent">
            <span className="dot" />
            {t("library.batch.selected", { count: selectedCount })}
          </span>
          <span className="grow" />
          <button
            type="button"
            className="btn btn-secondary sm"
            disabled={batchPending || !actionsEnabled}
            onClick={() => void runBatchAction("reindex")}
          >
            {batchState.status === "reindexing" ? <Loader2 size={15} className="spin" /> : <RefreshCcw size={15} />}
            <span>{batchState.status === "reindexing" ? t("common.reindexing") : t("common.reindex")}</span>
          </button>
          <button
            type="button"
            className="btn btn-danger sm"
            disabled={batchPending || !actionsEnabled}
            onClick={() => void runBatchAction("delete")}
          >
            {batchState.status === "deleting" ? <Loader2 size={15} className="spin" /> : <Trash2 size={15} />}
            <span>{batchState.status === "deleting" ? t("common.deleting") : t("common.delete")}</span>
          </button>
          <button
            type="button"
            className="btn btn-ghost sm"
            disabled={batchPending}
            onClick={() => setSelectedItemIds(new Set())}
          >
            {t("library.batch.clear")}
          </button>
        </div>
      ) : null}
      {items.length > 0 && filteredItems.length > 0 ? (
        <div className={viewMode === "grid" ? "lib-grid" : "tbl lib-table"}>
          {viewMode === "list" ? (
            <div className="lib-table-head" aria-hidden="true">
              <span>{t("library.col.title")}</span>
              <span>{t("library.col.source")}</span>
              <span>{t("library.col.duration")}</span>
              <span>{t("library.col.indexed")}</span>
              <span>{t("library.col.searchability")}</span>
            </div>
          ) : null}
          {filteredItems.map((item) => (
            <ItemCard
              key={item.id}
              item={item}
              viewMode={viewMode}
              selectable
              selected={selectedItemIds.has(item.id)}
              onSelect={(selected) => toggleItemSelection(item.id, selected)}
              onOpen={() => onOpenItem(item)}
            />
          ))}
        </div>
      ) : items.length === 0 ? (
        // Empty state lives outside the grid so it centers across the full
        // width instead of being trapped in the first 360px grid cell.
        <EmptyState
          title={t("library.empty.none.title")}
          body={t("library.empty.none.body")}
          actionLabel={t("library.empty.addSource")}
          onAction={onAddSource}
        />
      ) : (
        <EmptyState
          title={t("library.empty.filtered.title")}
          body={t("library.empty.filtered.body")}
          actionLabel={t("common.clearFilters")}
          onAction={clearLibraryFilters}
        />
      )}
    </div>
  );
}

function ItemDetail({
  item,
  apiStatus,
  actionsEnabled,
  startTimestamp,
  onBack,
  onDeleteItem,
  onReindexItem,
  onItemUpdated,
  requestConfirm,
}: {
  item: Item;
  apiStatus: ApiStatus;
  actionsEnabled: boolean;
  startTimestamp: string;
  onBack: () => void;
  onDeleteItem: (item: Item) => Promise<void>;
  onReindexItem: (item: Item) => Promise<void>;
  onItemUpdated: () => Promise<void>;
  requestConfirm: RequestConfirm;
}) {
  const t = useT();
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [playerChapters, setPlayerChapters] = useState<PlayerChapter[]>([]);
  const handleUnderstandingChapters = useCallback((chapters: api.VideoUnderstandingChapter[]) => {
    setPlayerChapters(
      chapters
        .filter((chapter) => chapter.start_sec !== null)
        .map((chapter) => ({ seconds: chapter.start_sec as number, title: chapter.title })),
    );
  }, []);
  const [currentTimestamp, setCurrentTimestamp] = useState(startTimestamp);
  const [chunkState, setChunkState] = useState<{
    status: "idle" | "loading" | "loaded" | "error";
    lines: TranscriptLine[];
    message: string | null;
  }>({
    status: "idle",
    lines: transcript,
    message: null,
  });
  const [itemAction, setItemAction] = useState<{
    status: "idle" | "locating" | "reindexing" | "deleting" | "queued" | "error";
    message: string | null;
  }>({ status: "idle", message: null });
  const detailIssue = itemDetailIssue(item, t);
  const transcriptLines =
    apiStatus === "online" && chunkState.status !== "idle" ? chunkState.lines : transcript;
  const momentActions = useItemMoments(
    item,
    actionsEnabled && chunkState.status === "loaded",
  );
  const playerMarkers: PlayerMarker[] = useMemo(
    () =>
      transcriptLines
        .map((line) => ({
          seconds: parseTimestampSeconds(line.time),
          label: line.time,
          text: line.text,
        }))
        .filter((marker) => Number.isFinite(marker.seconds) && marker.seconds >= 0),
    [transcriptLines],
  );
  // Show a real inline video player whenever we have any chunk to point
  // at: prefer the existing thumbnail chunk (so we can use the same chunk
  // id used for the keyframe), otherwise use the first transcript line.
  const playableChunkId =
    item.contentType === "video"
      ? extractChunkIdFromThumbnail(item.thumbnailUrl) ??
        (chunkState.status === "loaded" ? chunkState.lines[0]?.id : null) ??
        null
      : null;
  const itemPlaybackUrl = playableChunkId ? api.videoSegmentUrl(playableChunkId) : null;

  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "error">("idle");
  const itemBusy =
    itemAction.status === "reindexing" ||
    itemAction.status === "deleting" ||
    itemAction.status === "locating";
  const timestampLink = timestampDeepLink(item.id, currentTimestamp);
  // Resolve the chunk to clip from the LIVE playhead when the export popover
  // opens (falls back to currentTimestamp / the thumbnail chunk).
  function resolveClipTarget(): ClipTarget | null {
    const video = videoRef.current;
    // Use the live playhead once the video has actually moved; before that,
    // fall back to the timestamp the screen opened at.
    const liveSec =
      video && Number.isFinite(video.currentTime) && video.currentTime > 0.1
        ? video.currentTime
        : parseTimestampSeconds(currentTimestamp);
    return resolveClipTarget_(transcriptLines, liveSec);
  }

  useEffect(() => {
    if (copyStatus === "idle") {
      return;
    }
    const timeout = window.setTimeout(() => setCopyStatus("idle"), 1600);
    return () => window.clearTimeout(timeout);
  }, [copyStatus]);

  usePlaybackPositionPersistence({
    itemId: item.id,
    videoRef,
    chunkId: playableChunkId,
    enabled: actionsEnabled && Boolean(itemPlaybackUrl),
  });

  useEffect(() => {
    setItemAction({ status: "idle", message: null });
  }, [item.id]);

  useEffect(() => {
    setCurrentTimestamp(startTimestamp);
    if (startTimestamp === "0:00") {
      return;
    }
    seekTo(startTimestamp);
  }, [item.id, itemPlaybackUrl, startTimestamp]);

  useEffect(() => {
    function onKeyDown(event: globalThis.KeyboardEvent) {
      if (hasOpenModalSurface()) {
        return;
      }
      if (event.key === "Escape") {
        event.preventDefault();
        onBack();
        return;
      }
      const target = event.target as HTMLElement | null;
      if (
        target &&
        (target.tagName === "INPUT" ||
          target.tagName === "TEXTAREA" ||
          target.tagName === "BUTTON" ||
          target.tagName === "A" ||
          target.tagName === "SELECT" ||
          target.tagName === "VIDEO" ||
          target.isContentEditable ||
          target.getAttribute("role") === "button")
      ) {
        return;
      }
      const video = videoRef.current;
      if (!video) {
        return;
      }
      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        if (video.paused) {
          void video.play().catch(() => undefined);
        } else {
          video.pause();
        }
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        video.currentTime = Math.min(video.duration || Number.POSITIVE_INFINITY, video.currentTime + 5);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        video.currentTime = Math.max(0, video.currentTime - 5);
      } else if (event.key === "ArrowUp") {
        event.preventDefault();
        video.volume = Math.min(1, video.volume + 0.1);
      } else if (event.key === "ArrowDown") {
        event.preventDefault();
        video.volume = Math.max(0, video.volume - 0.1);
      } else if (event.key.toLowerCase() === "m") {
        video.muted = !video.muted;
      } else if (event.key.toLowerCase() === "f") {
        if (document.fullscreenElement) {
          void document.exitFullscreen().catch(() => undefined);
        } else if (video.requestFullscreen) {
          void video.requestFullscreen().catch(() => undefined);
        }
      }
    }
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onBack]);

  useEffect(() => {
    if (apiStatus !== "online") {
      setChunkState({ status: "idle", lines: transcript, message: null });
      return;
    }

    let cancelled = false;
    setChunkState({ status: "loading", lines: [], message: null });
    api
      .listItemChunks(item.id)
      .then((records) => {
        if (cancelled) {
          return;
        }
        setChunkState({ status: "loaded", lines: mapChunkRecords(records), message: null });
      })
      .catch((error) => {
        if (cancelled) {
          return;
        }
        setChunkState({ status: "error", lines: [], message: errorMessage(error) });
      });

    return () => {
      cancelled = true;
    };
  }, [apiStatus, item.id]);

  async function locateSourceFile() {
    setItemAction({ status: "locating", message: null });
    const selected = await openDialog({
      multiple: false,
      directory: false,
      filters: [{ name: "Video", extensions: ["mp4", "mkv", "webm", "mov", "m4v"] }],
    }).catch(() => null);
    if (typeof selected === "string" && selected.trim()) {
      try {
        await api.updateItemRawPath(item.id, selected.trim());
        await onItemUpdated();
        setItemAction({
          status: "idle",
          message: t("detail.locatedSource", { path: selected }),
        });
      } catch (error) {
        setItemAction({ status: "error", message: errorMessage(error) });
      }
      return;
    }
    setItemAction({ status: "idle", message: null });
  }

  async function openOriginalSource() {
    if (!canOpenOriginalSource(item)) {
      return;
    }
    if (!item.originalUrl) {
      setItemAction({ status: "locating", message: null });
    }
    try {
      const message = await openOriginalSourceForItem(item, t);
      if (!item.originalUrl) {
        setItemAction({ status: "queued", message });
      }
    } catch (error) {
      setItemAction({ status: "error", message: errorMessage(error) });
    }
  }

  async function reindexCurrentItem() {
    if (!actionsEnabled) {
      setItemAction({ status: "error", message: t("common.coreUnreachable") });
      return;
    }

    const confirmed = await requestConfirm({
      title: t("common.confirm.reindex.title"),
      body: t("common.confirm.reindex.body"),
      confirmLabel: t("common.reindex"),
    });
    if (!confirmed) {
      return;
    }

    setItemAction({ status: "reindexing", message: null });
    try {
      await onReindexItem(item);
      setItemAction({ status: "queued", message: t("common.reindexQueued") });
    } catch (error) {
      setItemAction({ status: "error", message: errorMessage(error) });
    }
  }

  async function deleteCurrentItem() {
    if (!actionsEnabled) {
      setItemAction({ status: "error", message: t("common.coreUnreachable") });
      return;
    }
    const confirmed = await requestConfirm({
      title: t("common.confirm.delete.title"),
      body: t("common.confirm.delete.body", { title: item.title }),
      confirmLabel: t("common.delete"),
    });
    if (!confirmed) {
      return;
    }

    setItemAction({ status: "deleting", message: null });
    try {
      await onDeleteItem(item);
    } catch (error) {
      setItemAction({ status: "error", message: errorMessage(error) });
    }
  }

  async function copyCitation() {
    try {
      const quote = transcriptLines.find((line) => line.time === currentTimestamp)?.text;
      const citation = buildMomentCitation({
        title: item.title,
        timestamp: currentTimestamp,
        quote,
        link: item.originalUrl ?? timestampLink,
      });
      await writeClipboardText(citation);
      setCopyStatus("copied");
    } catch (error) {
      // Surface the failure (the header button has no error affordance, so a
      // failed copy used to look like nothing happened).
      setCopyStatus("error");
      setItemAction({ status: "error", message: errorMessage(error) });
    }
  }


  // Seek the inline player to a timestamp. The /video-segment endpoint serves the
  // full source video with Range support, so the loaded src is the whole file —
  // we just move currentTime. Drives the transcript rows and the Gemini chapters
  // / key moments.
  function seekTo(timestamp: string) {
    const targetSeconds = parseTimestampSeconds(timestamp);
    if (!Number.isFinite(targetSeconds)) {
      return;
    }
    setCurrentTimestamp(timestamp);
    const video = videoRef.current;
    if (!video) {
      return;
    }
    const applySeek = () => {
      const maxTime = Number.isFinite(video.duration)
        ? Math.max(video.duration - 0.1, 0)
        : targetSeconds;
      video.currentTime = Math.min(targetSeconds, maxTime);
      void video.play().catch(() => undefined);
    };
    if (video.readyState >= 1) {
      applySeek();
    } else {
      video.addEventListener("loadedmetadata", applySeek, { once: true });
    }
  }

  return (
    <div className="page wide">
      <div className="page-head">
        <button className="btn btn-ghost sm" type="button" onClick={onBack}>
          <ChevronRight size={15} style={{ transform: "rotate(180deg)" }} />
          <span>{t("library.heading")}</span>
        </button>
        <div
          className="row"
          style={{ alignItems: "flex-start", justifyContent: "space-between", gap: 12, marginTop: 12 }}
        >
          <div style={{ minWidth: 0 }}>
            <h1 className="page-h1">{item.title}</h1>
            {/* One inline subtitle (source · duration · searchable · indexed),
                replacing the old 6-row table that exposed chunk count / model
                / per-item $. */}
            <p className="page-sub">
              {item.source} · <span className="mono">{item.duration}</span> · {itemModalityLabel(item, t)} ·{" "}
              {item.indexedAtEpoch === null
                ? t("detail.notIndexed")
                : t("detail.indexedAt", { when: item.indexedAt })}
            </p>
          </div>
          <div className="row gap-2" style={{ flex: "none" }}>
            <button className="btn btn-ghost sm" type="button" onClick={() => void copyCitation()}>
              {copyStatus === "copied" ? <Check size={15} /> : <Copy size={15} />}
              <span>{copyStatus === "copied" ? t("detail.copy.copied") : t("detail.copy.label")}</span>
            </button>
            <button
              className="btn btn-secondary sm"
              type="button"
              disabled={!canOpenOriginalSource(item) || itemBusy}
              onClick={() => void openOriginalSource()}
            >
              {item.originalUrl ? <ExternalLink size={15} /> : <Folder size={15} />}
              <span>{item.originalUrl ? t("detail.source.openOriginal") : t("detail.source.reveal")}</span>
            </button>
            <ClipExportButton
              contentType={item.contentType}
              disabled={itemBusy}
              resolveTarget={resolveClipTarget}
            />
            <DetailActionsMenu
              onExportMarkdown={
                transcriptLines.length > 0
                  ? () =>
                      downloadTextFile(
                        `${transcriptFilenameBase(item.title)}.md`,
                        transcriptToMarkdown(item.title, transcriptLines),
                        "text/markdown;charset=utf-8",
                      )
                  : undefined
              }
              onExportSrt={
                transcriptLines.length > 0
                  ? () =>
                      downloadTextFile(
                        `${transcriptFilenameBase(item.title)}.srt`,
                        transcriptToSrt(transcriptLines),
                        "text/plain;charset=utf-8",
                      )
                  : undefined
              }
              onReindex={() => void reindexCurrentItem()}
              onDelete={() => void deleteCurrentItem()}
              busy={itemBusy}
              reindexing={itemAction.status === "reindexing"}
              deleting={itemAction.status === "deleting"}
            />
          </div>
        </div>
      </div>

      <div className="detail-split">
        <div className="detail-media">
          {detailIssue ? (
            <div className="detail-media-issue">
              <DetailIssuePanel
                issue={detailIssue}
                actionStatus={itemAction.status}
                actionsEnabled={actionsEnabled}
                hasOriginalUrl={Boolean(item.originalUrl)}
                onLocate={() => void locateSourceFile()}
                onOpenOriginal={() => void openOriginalSource()}
                onReindex={() => void reindexCurrentItem()}
                onRemove={() => void deleteCurrentItem()}
              />
            </div>
          ) : itemPlaybackUrl ? (
            <CerulPlayer
              videoRef={videoRef}
              src={itemPlaybackUrl}
              markers={playerMarkers}
              chapters={playerChapters}
              ariaLabel={t("itemDetail.player.aria", { title: item.title })}
              fallbackDurationSec={item.durationSec}
              onSeekMarker={(marker) => seekTo(marker.label)}
            />
          ) : (
            <div className={`video-frame ${item.color}`}>
              <button
                className="play-button"
                type="button"
                aria-label={
                  item.status === "indexing"
                    ? t("itemDetail.player.waitingAria")
                    : t("itemDetail.player.noChunkAria")
                }
                disabled
              >
                <Play size={24} fill="currentColor" />
              </button>
            </div>
          )}
          {/* The 6-row metadata table (source / ingested / duration / chunks /
              usage / model) was removed: source·duration·searchable·indexed now
              live in the header subtitle, and chunk count / per-item $ / model
              were internal/diagnostic noise. Per-item spend lives in
              Settings → Account & Usage. */}
        </div>
        <div className="detail-transcript">
          <VideoUnderstandingPanel
            item={item}
            enabled={actionsEnabled}
            onSeek={seekTo}
            requestConfirm={requestConfirm}
            onChapters={handleUnderstandingChapters}
          />
          {itemAction.message ? (
            <p
              className={itemAction.status === "error" ? "field-error" : "field-hint"}
              role="status"
            >
              {itemAction.message}
            </p>
          ) : null}
          {momentActions.message ? <InlineNotice tone="error" message={momentActions.message} /> : null}
          {chunkState.status === "loading" ? <TranscriptSkeleton /> : null}
          {chunkState.status === "error" && chunkState.message ? (
            <InlineNotice tone="error" message={chunkState.message} />
          ) : null}
          {chunkState.status === "loaded" &&
          transcriptLines.length === 0 &&
          item.status === "indexing" ? (
            <InlineNotice tone="muted" message={t("detail.stillProcessing")} />
          ) : null}
          {item.visualIndexMessage ? (
            <InlineNotice tone="muted" message={item.visualIndexMessage} />
          ) : null}
          {item.embeddingIndexMessage ? (
            <InlineNotice tone="muted" message={item.embeddingIndexMessage} />
          ) : null}
          {chunkState.status !== "loading" && transcriptLines.length > 0 ? (
            <TranscriptList
              lines={transcriptLines}
              videoRef={videoRef}
              videoReady={Boolean(itemPlaybackUrl)}
              activeTime={currentTimestamp}
              onSeek={seekTo}
              renderAction={(line) => {
                const saved = Boolean(momentActions.momentForLine(line));
                return (
                  <MomentLineAction
                    saved={saved}
                    pending={momentActions.pendingLineId === line.id}
                    disabled={!actionsEnabled}
                    onToggle={() => void momentActions.toggle(line)}
                  />
                );
              }}
            />
          ) : null}
        </div>
      </div>
    </div>
  );
}

function SettingsScreen({
  section,
  setSection,
  apiStatus,
  settings,
  daemonStatus,
  onSettingsChange,
  requestConfirm,
}: {
  section: string;
  setSection: (section: string) => void;
  apiStatus: ApiStatus;
  settings: api.SettingsMap;
  daemonStatus: DaemonStatus | null;
  onSettingsChange: (settings: api.SettingsMap) => Promise<void>;
  requestConfirm: RequestConfirm;
}) {
  const t = useT();
  const sectionIcons: Record<string, LucideIcon> = {
    General: SlidersHorizontal,
    Models: Cpu,
    Usage: Wallet,
    Indexing: ListChecks,
    Storage: HardDrive,
    Advanced: Wrench,
    About: Info,
  };
  const sectionLabels: Record<string, string> = {
    General: t("settings.section.general"),
    Models: t("settings.section.models"),
    Usage: t("settings.section.usage"),
    Indexing: t("settings.section.indexing"),
    Storage: t("settings.section.storage"),
    Advanced: t("settings.section.advanced"),
    About: t("settings.section.about"),
  };
  const controlsDisabled = apiStatus !== "online";
  const activeSection = normalizeSettingsSection(section);
  const [saveState, setSaveState] = useState<{
    status: SaveStatus;
    message: string;
  }>({ status: "idle", message: t("settings.save.idle") });

  useEffect(() => {
    if (saveState.status !== "saved") {
      return;
    }

    const timeout = window.setTimeout(() => {
      setSaveState({ status: "idle", message: t("settings.save.idle") });
    }, 1600);
    return () => window.clearTimeout(timeout);
  }, [saveState.status]);

  async function saveSettings(settingsPatch: api.SettingsMap) {
    if (controlsDisabled) {
      setSaveState({
        status: "error",
        message: t("settings.save.unreachable"),
      });
      return;
    }

    setSaveState({ status: "saving", message: t("settings.save.saving") });
    try {
      await onSettingsChange(settingsPatch);
      setSaveState({ status: "saved", message: t("settings.save.saved") });
    } catch (error) {
      setSaveState({ status: "error", message: errorMessage(error) });
    }
  }

  async function saveGlobalHotkey(label: string) {
    if (controlsDisabled) {
      setSaveState({
        status: "error",
        message: t("settings.save.unreachable"),
      });
      return;
    }

    setSaveState({ status: "saving", message: t("settings.save.saving") });
    try {
      await setGlobalHotkey(label);
      await onSettingsChange({ global_hotkey: label });
      setSaveState({ status: "saved", message: t("settings.save.hotkeyUpdated") });
    } catch (error) {
      setSaveState({ status: "error", message: errorMessage(error) });
    }
  }

  async function saveStartAtLogin(enabled: boolean) {
    if (controlsDisabled) {
      setSaveState({
        status: "error",
        message: t("settings.save.unreachable"),
      });
      return;
    }

    setSaveState({ status: "saving", message: t("settings.save.saving") });
    try {
      const result = enabled ? await installDaemon() : await uninstallDaemon();
      await onSettingsChange({ start_at_login: result.installed });
      setSaveState({
        status: enabled === result.installed ? "saved" : "error",
        message:
          enabled === result.installed
            ? result.message
            : t("settings.save.startupUnavailable"),
      });
    } catch (error) {
      setSaveState({ status: "error", message: errorMessage(error) });
    }
  }

  const saveChipClass =
    saveState.status === "error"
      ? "chip danger"
      : saveState.status === "saved"
        ? "chip success"
        : saveState.status === "saving"
          ? "chip neutral"
          : "chip neutral";

  return (
    <div className="page">
      <div className="page-head row" style={{ alignItems: "flex-end", justifyContent: "space-between" }}>
        <div>
          <p className="page-eyebrow">{t("settings.eyebrow")}</p>
          <h1 className="page-h1">{sectionLabels[activeSection] ?? activeSection}</h1>
        </div>
        <span className={saveChipClass} role="status" aria-live="polite">
          {saveState.status === "saving" ? <Loader2 size={13} /> : <Check size={13} />}
          {saveState.message}
        </span>
      </div>

      <div className="settings-wrap">
        <nav className="settings-nav" aria-label={t("settings.nav.aria")}>
          {settingsSections.map((item) => {
            const Icon = sectionIcons[item];
            return (
              <button
                key={item}
                type="button"
                className={item === activeSection ? "active" : ""}
                onClick={() => setSection(item)}
              >
                {Icon ? <Icon size={16} /> : null}
                <span>{sectionLabels[item] ?? item}</span>
              </button>
            );
          })}
        </nav>
        <div className="settings-panel">
          {apiStatus !== "online" ? (
            <p className="field-hint" style={{ marginBottom: 18 }}>{t("settings.offlineNotice")}</p>
          ) : null}
          {activeSection === "General" ? (
            <GeneralSettings
              settings={settings}
              daemonStatus={daemonStatus}
              disabled={controlsDisabled}
              onSettingsChange={saveSettings}
              onStartAtLoginChange={saveStartAtLogin}
              onHotkeyChange={saveGlobalHotkey}
            />
          ) : null}
          {activeSection === "Indexing" ? (
            <IndexingSettings
              settings={settings}
              disabled={controlsDisabled}
              onSettingsChange={saveSettings}
            />
          ) : null}
          {activeSection === "Models" ? (
            <ModelsSettings
              settings={settings}
              disabled={controlsDisabled}
              onSettingsChange={saveSettings}
              requestConfirm={requestConfirm}
            />
          ) : null}
          {activeSection === "Usage" ? <UsageSettings /> : null}
          {activeSection === "Storage" ? (
            <StorageSettings requestConfirm={requestConfirm} />
          ) : null}
          {activeSection === "Advanced" ? (
            <AdvancedSettings
              settings={settings}
              disabled={controlsDisabled}
              onSettingsChange={saveSettings}
            />
          ) : null}
          {activeSection === "About" ? <AboutSettings /> : null}
        </div>
      </div>
    </div>
  );
}

function GeneralSettings({
  settings,
  daemonStatus,
  disabled,
  onSettingsChange,
  onStartAtLoginChange,
  onHotkeyChange,
}: {
  settings: api.SettingsMap;
  daemonStatus: DaemonStatus | null;
  disabled: boolean;
  onSettingsChange: (settings: api.SettingsMap) => Promise<void>;
  onStartAtLoginChange: (enabled: boolean) => Promise<void>;
  onHotkeyChange: (label: string) => Promise<void>;
}) {
  const t = useT();
  const { lang, setLang } = useLang();
  const theme = settingString(settings, "theme", "System");
  const globalHotkey = settingString(settings, "global_hotkey", "Alt+Space");
  const startAtLoginEnabled =
    daemonStatus?.installed ?? settingBoolean(settings, "start_at_login", true);
  // The description explains what the toggle does; transient daemon status
  // ("checking...") is appended only once it resolves to something useful.
  const startAtLoginStatus = daemonStatus
    ? daemonStatus.installed
      ? daemonStatus.path
        ? t("settings.general.daemon.installedAt", { path: daemonStatus.path })
        : t("settings.general.daemon.installed")
      : t("settings.general.daemon.notInstalled")
    : null;
  const startAtLoginDescription = startAtLoginStatus
    ? `${t("settings.general.startAtLogin.description")} ${startAtLoginStatus}`
    : t("settings.general.startAtLogin.description");
  const languageOptions: { value: string; label: string; disabled?: boolean }[] = [
    { value: "zh", label: t("settings.general.language.zh") },
    { value: "en", label: t("settings.general.language.en") },
  ];

  return (
    <>
      <SettingsGroup title={t("settings.general.appearance")}>
        <SettingRow
          label={t("settings.general.theme")}
          control={
            <Segmented
              values={["System", "Light", "Dark"]}
              labels={{
                System: t("settings.general.theme.system"),
                Light: t("settings.general.theme.light"),
                Dark: t("settings.general.theme.dark"),
              }}
              value={theme}
              disabled={disabled}
              onChange={(value) => void onSettingsChange({ theme: value })}
            />
          }
        />
        <SettingRow
          label={t("settings.general.language")}
          control={
            <div className="segmented">
              {languageOptions.map((option) => (
                <button
                  key={option.value}
                  type="button"
                  className={option.value === lang ? "active" : ""}
                  disabled={option.disabled}
                  onClick={() => {
                    if (option.value === "zh" || option.value === "en") {
                      setLang(option.value);
                    }
                  }}
                >
                  {option.label}
                </button>
              ))}
            </div>
          }
        />
      </SettingsGroup>
      <SettingsGroup title={t("settings.general.startup")}>
        <SettingRow
          label={t("settings.general.startAtLogin")}
          description={startAtLoginDescription}
          control={
            <Toggle
              checked={startAtLoginEnabled}
              disabled={disabled}
              onChange={(checked) => void onStartAtLoginChange(checked)}
            />
          }
        />
        <SettingRow
          label={t("settings.general.closeToTray.label")}
          control={
            <Toggle
              checked={settingBoolean(settings, "close_to_tray", true)}
              disabled={disabled}
              onChange={(checked) => void onSettingsChange({ close_to_tray: checked })}
            />
          }
        />
      </SettingsGroup>
      <SettingsGroup title={t("settings.general.shortcuts")}>
        <SettingRow
          label={t("settings.general.globalHotkey")}
          description={t("settings.general.globalHotkey.hint")}
          control={
            <select
              className="select"
              value={globalHotkey}
              disabled={disabled}
              onChange={(event) => void onHotkeyChange(event.currentTarget.value)}
            >
              {globalHotkeyOptions.map((option) => (
                <option key={option} value={option}>
                  {formatHotkeyLabel(option)}
                </option>
              ))}
            </select>
          }
        />
        <SettingRow
          label={t("settings.general.accessibility.label")}
          description={t("settings.general.accessibility.description")}
          control={
            <button className="btn btn-secondary sm" type="button" onClick={openAccessibilitySettings}>
              {t("settings.general.accessibility.openButton")}
            </button>
          }
        />
      </SettingsGroup>
    </>
  );
}

function IndexingSettings({
  settings,
  disabled,
  onSettingsChange,
}: {
  settings: api.SettingsMap;
  disabled: boolean;
  onSettingsChange: (settings: api.SettingsMap) => Promise<void>;
}) {
  const t = useT();
  const concurrentJobs = Math.min(Math.max(settingNumber(settings, "concurrent_jobs", 2), 1), 4);
  // Track the value locally while dragging; persist once on release —
  // each tick used to fire a PATCH plus a 7-request full refresh.
  const [jobsDraft, setJobsDraft] = useState<number | null>(null);
  const shownJobs = jobsDraft ?? concurrentJobs;
  const commitJobs = () => {
    if (jobsDraft !== null && jobsDraft !== concurrentJobs) {
      void onSettingsChange({ concurrent_jobs: jobsDraft });
    }
    setJobsDraft(null);
  };

  return (
    <>
      <SettingsGroup title={t("settings.indexing.performance.title")}>
        <SettingRow
          label={t("settings.indexing.concurrentJobs.label")}
          description={t("settings.indexing.concurrentJobs.description")}
          control={
            <div className="col gap-2" style={{ alignItems: "flex-end" }}>
              <span className="chip neutral">
                {shownJobs} {t("settings.indexing.concurrentJobs.unit")}
              </span>
              <input
                type="range"
                min={1}
                max={4}
                value={shownJobs}
                disabled={disabled}
                onChange={(event) => setJobsDraft(Number(event.currentTarget.value))}
                onPointerUp={commitJobs}
                onKeyUp={commitJobs}
                onBlur={commitJobs}
              />
            </div>
          }
        />
        <SettingRow
          label={t("settings.indexing.pauseOnBattery.label")}
          control={
            <Toggle
              checked={settingBoolean(settings, "pause_on_battery", false)}
              disabled={disabled}
              onChange={(checked) => void onSettingsChange({ pause_on_battery: checked })}
            />
          }
        />
        <SettingRow
          label={t("settings.indexing.pauseLowPower.label")}
          control={
            <Toggle
              checked={settingBoolean(settings, "pause_in_low_power_mode", true)}
              disabled={disabled}
              onChange={(checked) => void onSettingsChange({ pause_in_low_power_mode: checked })}
            />
          }
        />
      </SettingsGroup>
      <SettingsGroup title={t("settings.indexing.files.title")}>
        <SettingRow
          label={t("settings.indexing.keepRaw.label")}
          description={t("settings.indexing.keepRaw.description")}
          control={
            <Toggle
              checked={settingBoolean(settings, "keep_raw_video_files", false)}
              disabled={disabled}
              onChange={(checked) => void onSettingsChange({ keep_raw_video_files: checked })}
            />
          }
        />
        <SettingRow
          stacked
          label={t("settings.indexing.scanMac.label")}
          control={<ScanThisMacControl disabled={disabled} />}
        />
      </SettingsGroup>
    </>
  );
}

// One row of the unified capability list (转录 / 向量嵌入 / 视频理解). The
// three are fixed; each carries its model + the connection/key it routes
// through, handled together in a single list.
type CapabilityRowModel = {
  key: string;
  badge: string;
  name: string;
  isLocal: boolean;
  locked: boolean;
  // Whether the model is user-selectable here (combobox) vs a fixed display.
  // Embedding is locked; on-device ASR is the one bundled model; video lets you
  // pick a local VLM or a remote model.
  modelEditable: boolean;
  localLabel: string;
  modelValue: string;
  modelOptions: ModelComboOption[];
  onSelectModel?: (id: string) => void;
  provider: api.ProviderRecord | null;
  note: string | null;
  // Which bundled on-device model backs this capability — used to show the real
  // download state ("未下载 / 下载中 / 就绪") instead of a blanket "ready" when
  // running locally. null for capabilities with no local weights to fetch.
  localModelKey: "embed" | "asr" | "ocr" | null;
};

function ModelsSettings({
  settings,
  disabled,
  onSettingsChange,
  requestConfirm,
}: {
  settings: api.SettingsMap;
  disabled: boolean;
  onSettingsChange: (settings: api.SettingsMap) => Promise<void>;
  requestConfirm: RequestConfirm;
}) {
  const t = useT();
  const inferenceMode = settingString(settings, "inference_mode", "remote");
  const processingMode = settingString(
    settings,
    "processing_mode",
    inferenceToProcessing(inferenceMode),
  );
  const selectedAsr = settingString(settings, "asr_model", "whisper-1");
  const selectedAsrProvider = settingString(settings, "asr_provider_id", "");
  const selectedEmbeddingProvider = settingString(settings, "embedding_provider_id", "");
  const selectedVideoUnderstandingProvider = settingString(
    settings,
    "video_understanding_provider_id",
    "",
  );
  const selectedVideoUnderstandingModel = settingString(
    settings,
    "video_understanding_model",
    "gemini-3.5-flash",
  );
  const [catalog, setCatalog] = useState<api.ModelCatalogResponse | null>(null);
  const [providers, setProviders] = useState<api.ProviderRecord[]>([]);
  const [providersError, setProvidersError] = useState<string | null>(null);
  const [usageSummary, setUsageSummary] = useState<api.UsageSummary | null>(null);
  // Real on-device download state, so the capability rows reflect actual weights
  // on disk (未下载 / 下载中 / 就绪) rather than a blanket "ready" in local mode.
  const [localPrep, setLocalPrep] = useState<api.LocalPrepareStatus | null>(null);

  async function downloadLocalModels(modelKey?: string) {
    try {
      const next = await api.prepareLocalModels(modelKey ? [modelKey] : undefined);
      setLocalPrep(next);
    } catch {
      /* best-effort; the poller will reflect the real state */
    }
  }

  async function pauseLocalDownload() {
    try {
      // Cancel keeps partial files on disk, so a later "download" resumes.
      const next = await api.cancelLocalModelPrepare();
      setLocalPrep(next);
    } catch {
      /* best-effort; the poller will reflect the real state */
    }
  }

  async function deleteLocalModel(modelKey: string) {
    const confirmed = await requestConfirm({
      title: t("settings.models.localDownload.deleteConfirm.title"),
      body: t("settings.models.localDownload.deleteConfirm.body"),
      confirmLabel: t("settings.models.localDownload.deleteConfirm.confirm"),
    });
    if (!confirmed) {
      return;
    }
    try {
      const next = await api.deleteLocalModels([modelKey]);
      setLocalPrep(next);
    } catch {
      /* best-effort; the poller will reflect the real state */
    }
  }

  async function repairLocalModels(modelKey?: string) {
    try {
      const next = await api.repairLocalModels(modelKey ? [modelKey] : undefined);
      setLocalPrep(next);
    } catch {
      /* best-effort; the poller will reflect the real state */
    }
  }

  async function loadProviders() {
    try {
      const next = await api.listProviders();
      setProviders(next);
      setProvidersError(null);
    } catch (error) {
      setProvidersError(errorMessage(error));
    }
  }

  useEffect(() => {
    void loadProviders();
  }, []);

  // Both pollers skip ticks while the window is hidden — the settings
  // screen used to keep hitting the API every 4-5s in the background (and
  // kept firing failing requests while the core was offline).
  useEffect(() => {
    let cancelled = false;
    async function tick() {
      if (document.hidden) {
        return;
      }
      try {
        const nextCatalog = await api.getModelCatalog();
        if (!cancelled) {
          setCatalog(nextCatalog);
        }
      } catch {
        /* catalog is best-effort; capability cards fall back to defaults */
      }
    }
    void tick();
    const interval = window.setInterval(() => void tick(), 4000);
    const onVisible = () => {
      if (!document.hidden) void tick();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, []);

  // Poll the real on-device download state (cheap disk scan) while not on
  // pure-cloud mode, so the capability rows show 未下载 / 下载中 / 就绪 live.
  useEffect(() => {
    if (inferenceMode === "remote") {
      setLocalPrep(null);
      return;
    }
    let cancelled = false;
    async function tick() {
      if (document.hidden) return;
      try {
        const next = await api.localPrepareStatus();
        if (!cancelled) setLocalPrep(next);
      } catch {
        /* core offline or route absent — keep the last known state */
      }
    }
    void tick();
    const interval = window.setInterval(() => void tick(), 2000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, [inferenceMode]);

  useEffect(() => {
    let cancelled = false;
    async function tick() {
      if (document.hidden) {
        return;
      }
      try {
        const summary = await api.usageSummary();
        if (!cancelled) {
          setUsageSummary(summary);
        }
      } catch {
        if (!cancelled) {
          setUsageSummary(null);
        }
      }
    }
    void tick();
    const interval = window.setInterval(() => void tick(), 5000);
    return () => {
      cancelled = true;
      window.clearInterval(interval);
    };
  }, []);

  // ---- Per-capability model / provider options (drive the 3 fixed cards) ----
  const asrModels = catalog?.models.filter((model) => model.capability === "asr") ?? [];
  const remoteAsrModels = asrModels.filter((model) => model.tier !== "local");
  const remoteAsrOptions = remoteAsrModels.length > 0 ? remoteAsrModels : fallbackAsrModels;
  const activeRemoteAsr = selectedAsr.trim() || (remoteAsrOptions[0]?.id ?? "");
  const embeddingModels =
    catalog?.models.filter((model) => model.capability === "multimodal_embedding") ?? [];
  const videoUnderstandingModels =
    catalog?.models.filter((model) => model.capability === "video_understanding") ?? [];
  const activeProfile = catalog?.active_embedding_profile;
  const localRuntimeReady = catalog?.runtime.local_runtime_ready ?? false;
  const localRuntimeIssue = catalog?.runtime.local_runtime_error ?? null;
  const isAutoMode = inferenceMode === "auto";
  const isLocalMode = inferenceMode === "local";
  const effectiveLocalMode = isLocalMode || (isAutoMode && localRuntimeReady);
  const localAsrLabel =
    asrModels.find((model) => model.tier === "local")?.label ??
    t("settings.models.localAsr.fallbackLabel");
  // Resolve the connection bound to each capability, falling back to the
  // env-seeded default for that capability.
  const providerFor = (id: string, fallbackId: string) =>
    providers.find((provider) => provider.id === id) ??
    providers.find((provider) => provider.id === fallbackId) ??
    null;
  const toComboOptions = (
    list: { id: string; label: string; size_label?: string }[],
  ): ModelComboOption[] => list.map((m) => ({ id: m.id, label: m.label, hint: m.size_label }));
  // Embedding is mode-dependent: cloud uses the Gemini embedding, on-device uses
  // the bundled Qwen3-VL embedding. Show the one that matches the current mode
  // (not whatever a stale index profile was bound to).
  const embeddingLabel = effectiveLocalMode
    ? embeddingModels.find((model) => model.tier === "local")?.label ??
      activeProfile?.model_id ??
      "Qwen3-VL Embedding local"
    : embeddingModels.find((model) => model.tier !== "local")?.label ?? "Gemini Embedding 2";
  const capabilities: CapabilityRowModel[] = [
    {
      key: "asr",
      badge: t("settings.models.capability.asr.badge"),
      name: t("settings.models.transcription.kicker"),
      isLocal: effectiveLocalMode,
      locked: false,
      modelEditable: !effectiveLocalMode,
      localLabel: localAsrLabel,
      modelValue: activeRemoteAsr,
      modelOptions: toComboOptions(remoteAsrOptions),
      onSelectModel: (id) => void onSettingsChange({ asr_model: id }),
      provider: providerFor(selectedAsrProvider, "env-asr"),
      note: null,
      localModelKey: "asr",
    },
    {
      key: "embedding",
      badge: t("settings.models.capability.embedding.badge"),
      name: t("settings.models.embedding.kicker"),
      isLocal: effectiveLocalMode,
      locked: true,
      modelEditable: false,
      localLabel: embeddingLabel,
      modelValue: embeddingLabel,
      modelOptions: [],
      provider: providerFor(selectedEmbeddingProvider, "env-embedding"),
      note: t("settings.models.embedding.boundBadge"),
      localModelKey: "embed",
    },
    {
      key: "video",
      badge: t("settings.models.capability.video.badge"),
      name: t("settings.models.video.kicker"),
      isLocal: false,
      locked: false,
      modelEditable: true,
      localLabel: "",
      modelValue: selectedVideoUnderstandingModel,
      modelOptions: toComboOptions(videoUnderstandingModels),
      onSelectModel: (id) => void onSettingsChange({ video_understanding_model: id }),
      provider: providerFor(selectedVideoUnderstandingProvider, "env-video-understanding"),
      note: null,
      localModelKey: null,
    },
  ];

  return (
    <div className="models-settings-panel">
      <InferenceModeSelector
        processingMode={processingMode}
        usageSummary={usageSummary}
        disabled={disabled}
        onSettingsChange={onSettingsChange}
      />

      <section className="model-connections-shell">
        <div className="model-advanced-head">
          <div className="model-advanced-head__titles">
            <h2 className="model-advanced-title">{t("settings.models.advanced.title")}</h2>
            <p className="model-advanced-subtitle">{t("settings.models.advanced.subtitle")}</p>
          </div>
        </div>

        <ProviderConnections
          capabilities={capabilities}
          providers={providers}
          error={providersError}
          disabled={disabled}
          onRefresh={loadProviders}
          requestConfirm={requestConfirm}
          localPrep={localPrep}
          onDownloadLocal={downloadLocalModels}
          onPauseLocal={pauseLocalDownload}
          onRepairLocal={repairLocalModels}
          onDeleteLocal={deleteLocalModel}
          inferenceMode={inferenceMode}
        />
      </section>
    </div>
  );
}

type AsrModelOption = Pick<api.ModelCatalogRecord, "id" | "label" | "size_label">;

// Strip protocol + path so a connection's endpoint reads as a short host in the
// row sub-line ("https://api.groq.com/openai/v1" -> "api.groq.com"). (B2.)
function shortenEndpoint(url: string | null): string | null {
  if (!url) {
    return null;
  }
  return url.replace(/^https?:\/\//, "").replace(/\/.*$/, "");
}

type ModelComboOption = { id: string; label: string; hint?: string };

// B4 · One control for model selection: pick from the known/discovered list,
// type a custom model name, or refresh the list — replacing a stacked
// select + text input + two ghost buttons. Selecting applies immediately.
function ModelCombobox({
  value,
  options,
  disabled = false,
  busy = false,
  onSelect,
  onExplore,
  onOpen,
  ariaLabel,
}: {
  value: string;
  options: ModelComboOption[];
  disabled?: boolean;
  /** Discovery in flight — spins the refresh affordance. */
  busy?: boolean;
  /** Applies the chosen/typed model immediately. */
  onSelect: (id: string) => void;
  /** Re-fetch the provider's /models list. Omit to hide discovery. */
  onExplore?: () => void;
  /** Fired when the popup opens (used to auto-discover on first open). */
  onOpen?: () => void;
  ariaLabel?: string;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState("");
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
  useEscapeToClose(() => setOpen(false), open);
  useClickOutside(rootRef, () => setOpen(false), open);

  useEffect(() => {
    if (open) {
      inputRef.current?.focus();
    }
  }, [open]);

  function openPop() {
    if (disabled) {
      return;
    }
    setDraft("");
    setOpen(true);
    onOpen?.();
  }

  function choose(id: string) {
    const next = id.trim();
    setOpen(false);
    if (next && next !== value) {
      onSelect(next);
    }
  }

  const query = draft.trim().toLowerCase();
  const filtered = query
    ? options.filter(
        (option) =>
          option.id.toLowerCase().includes(query) || option.label.toLowerCase().includes(query),
      )
    : options;

  return (
    <div className={open ? "model-combobox open" : "model-combobox"} ref={rootRef}>
      <button
        type="button"
        className="model-combobox__field"
        disabled={disabled}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel ?? t("settings.models.combobox.aria")}
        onClick={() => (open ? setOpen(false) : openPop())}
      >
        <span className={value ? "model-combobox__value" : "model-combobox__value placeholder"}>
          {value || t("settings.models.combobox.placeholder")}
        </span>
        {onExplore ? (
          <RefreshCcw
            size={14}
            className={busy ? "model-combobox__refresh spin" : "model-combobox__refresh"}
          />
        ) : null}
        <ChevronDown size={15} className="model-combobox__chev" />
      </button>
      {open ? (
        <div className="model-combobox__pop">
          <div className="model-combobox__search">
            <input
              ref={inputRef}
              value={draft}
              placeholder={t("settings.models.combobox.searchPlaceholder")}
              onChange={(event) => setDraft(event.currentTarget.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") {
                  event.preventDefault();
                  if (draft.trim()) {
                    choose(draft);
                  }
                }
              }}
            />
          </div>
          <div className="model-combobox__list" role="listbox">
            {filtered.length > 0 ? (
              filtered.map((option) => (
                <button
                  type="button"
                  key={option.id}
                  className="model-combobox__opt"
                  role="option"
                  aria-selected={option.id === value}
                  onClick={() => choose(option.id)}
                >
                  <span className="model-combobox__opt-id">{option.id}</span>
                  {option.hint ? (
                    <span className="model-combobox__opt-hint">{option.hint}</span>
                  ) : null}
                </button>
              ))
            ) : (
              <p className="model-combobox__empty">
                {query
                  ? t("settings.models.combobox.customHint")
                  : t("settings.models.combobox.empty")}
              </p>
            )}
          </div>
          {onExplore ? (
            <div className="model-combobox__foot">
              <button type="button" disabled={busy} onClick={() => onExplore()}>
                <RefreshCcw size={13} />
                <span>
                  {busy
                    ? t("settings.models.combobox.refreshing")
                    : t("settings.models.combobox.refresh")}
                </span>
              </button>
              <span className="model-combobox__foot-hint">
                {t("settings.models.combobox.customHint")}
              </span>
            </div>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

const fallbackAsrModels: AsrModelOption[] = [
  { id: "whisper-1", label: "OpenAI Whisper", size_label: "usage-based" },
  { id: "gpt-4o-mini-transcribe", label: "OpenAI GPT-4o mini transcribe", size_label: "usage-based" },
  { id: "gpt-4o-transcribe", label: "OpenAI GPT-4o transcribe", size_label: "usage-based" },
];

function isGeminiAsrModelId(modelId: string) {
  return modelId.trim().toLowerCase().startsWith("gemini-");
}

// Maps the 4 UI processing presets (完整版 baseline) onto the 3 backend
// inference modes. `processing_mode` is persisted so the right card stays
// highlighted; `inference_mode` is what the daemon actually consumes. Two
// presets (auto/speed) share the balanced "auto" path — that's intentional:
// the cards are UX intents, not a 1:1 mirror of the backend's 3 modes.
const PROCESSING_TO_INFERENCE: Record<string, string> = {
  cloud: "remote",
  local: "local",
};
function inferenceToProcessing(inferenceMode: string): string {
  // Two presets only: 云端 API (default) vs 本地. Remote/auto map to cloud.
  return inferenceMode === "local" ? "local" : "cloud";
}

// Smart-processing selector — two selectable presets (云端 API / 仅在本机) plus a
// monthly-usage summary card. The cards ARE the switch.
function InferenceModeSelector({
  processingMode,
  usageSummary,
  disabled,
  onSettingsChange,
}: {
  processingMode: string;
  usageSummary: api.UsageSummary | null;
  disabled: boolean;
  onSettingsChange: (settings: api.SettingsMap) => Promise<void>;
}) {
  const t = useT();
  // Share of processing that ran on-device (free).
  const localShare =
    usageSummary && usageSummary.total.event_count > 0
      ? Math.round((usageSummary.local.event_count / usageSummary.total.event_count) * 100)
      : 0;
  const modes: {
    id: string;
    label: string;
    desc: string;
    badge: string | null;
    badgeTone: string;
  }[] = [
    {
      id: "cloud",
      label: t("settings.models.processing.cloud"),
      desc: t("settings.models.processing.cloud.desc"),
      badge: t("settings.models.processing.cloud.badge"),
      badgeTone: "accent",
    },
    {
      id: "local",
      label: t("settings.models.processing.local"),
      desc: t("settings.models.processing.local.desc"),
      badge: t("settings.models.processing.local.badge"),
      badgeTone: "success",
    },
  ];

  return (
    <section aria-label={t("settings.models.overview.aria")}>
      <div className="imode-head">
        <h2>{t("settings.models.inferenceMode.title")}</h2>
        <p>{t("settings.models.inferenceMode.description")}</p>
      </div>
      <div className="imode-grid">
        {modes.map((mode) => {
          const selected = processingMode === mode.id;
          return (
            <button
              type="button"
              key={mode.id}
              className={selected ? "imode-card selected" : "imode-card"}
              aria-pressed={selected}
              aria-label={`${mode.label}${selected ? ` · ${t("settings.models.processing.selectedAria")}` : ""}`}
              disabled={disabled}
              onClick={() => {
                if (!selected) {
                  void onSettingsChange({
                    processing_mode: mode.id,
                    inference_mode: PROCESSING_TO_INFERENCE[mode.id] ?? "auto",
                  });
                }
              }}
            >
              <div className="imode-card__top">
                <span className="imode-card__radio" aria-hidden="true">
                  {selected ? <span className="imode-card__radio-dot" /> : null}
                </span>
                <span className="imode-card__name">{mode.label}</span>
                {mode.badge ? (
                  <span className={`imode-card__badge ${mode.badgeTone}`}>{mode.badge}</span>
                ) : null}
              </div>
              <p className="imode-card__desc">{mode.desc}</p>
            </button>
          );
        })}
      </div>
      <div className="imode-usage-card">
        <div className="imode-usage-card__stat">
          <span className="imode-usage-card__label">{t("settings.models.usage.card.cost")}</span>
          <strong className="imode-usage-card__value">
            {formatUsd(usageSummary?.total.estimated_usd ?? 0)}
          </strong>
        </div>
        <div className="imode-usage-card__stat">
          <span className="imode-usage-card__label">{t("settings.models.usage.card.events")}</span>
          <strong className="imode-usage-card__value">{usageSummary?.total.event_count ?? 0}</strong>
        </div>
        <div className="imode-usage-card__share">
          <span className="imode-usage-card__label">{t("settings.models.usage.card.localShare")}</span>
          <div className="imode-usage-card__bar" aria-hidden="true">
            <div style={{ width: `${localShare}%` }} />
          </div>
          <span className="imode-usage-card__pct mono">{localShare}%</span>
        </div>
      </div>
    </section>
  );
}

// Merge the curated model options with models discovered from the provider's
// /models endpoint, de-duped by id (curated first).
function mergeComboOptions(
  base: ModelComboOption[],
  extra?: ModelComboOption[],
): ModelComboOption[] {
  if (!extra || extra.length === 0) return base;
  const seen = new Set(base.map((option) => option.id));
  return [...base, ...extra.filter((option) => !seen.has(option.id))];
}

type RemoteProviderType = Exclude<api.ProviderType, "local">;

const providerTypeOptions: { value: RemoteProviderType; label: string; placeholder: string }[] = [
  {
    value: "openai",
    label: "OpenAI",
    placeholder: "https://api.openai.com/v1",
  },
  {
    value: "gemini",
    label: "Gemini",
    placeholder: "https://generativelanguage.googleapis.com/v1beta",
  },
  {
    value: "openai-compatible",
    label: "OpenAI-compatible",
    placeholder: "https://your-provider.example/v1",
  },
];

// Persistent download status for on-device models: while a download runs it
// shows the live source + speed + ETA + a progress bar + pause; otherwise it
// surfaces a "download missing models" CTA (local mode), a cloud-mode note, or
// the last-used source/peak speed once a run has finished. Backs the
// "看不到下载速度 / 找不到下载页面" fix — the speed/source were previously only
// visible in the one-shot first-run dialog.
function LocalDownloadStatus({
  localPrep,
  inferenceMode,
  capabilities,
  disabled,
  onDownloadLocal,
  onPauseLocal,
  onRepairLocal,
}: {
  localPrep: api.LocalPrepareStatus | null;
  inferenceMode: string;
  capabilities: CapabilityRowModel[];
  disabled: boolean;
  onDownloadLocal: (modelKey?: string) => void;
  onPauseLocal: () => void;
  onRepairLocal: (modelKey?: string) => void;
}) {
  const t = useT();
  const [showProbes, setShowProbes] = useState(false);
  const [copied, setCopied] = useState(false);
  const [showDetails, setShowDetails] = useState(false);

  if (!localPrep) {
    return null;
  }
  const status = localPrep;
  const downloading = status.phase === "downloading";
  const isLocalMode = inferenceMode === "local" || inferenceMode === "auto";

  // Only the local models actually shown as cards here (embed/asr) drive the
  // "missing" CTA — OCR/aligner repos aren't user-actionable in this view.
  const localKeys = new Set(
    capabilities
      .filter((c) => c.isLocal && c.localModelKey)
      .map((c) => c.localModelKey as string),
  );
  const shownModels = status.models.filter((m) => localKeys.has(m.id));
  const missingCount = shownModels.filter((m) => m.status !== "ready").length;

  const speed = formatSpeed(status.download_bps);
  const lastSpeed = formatSpeed(status.last_download_bps);
  const eta = status.eta_seconds != null ? formatDuration(status.eta_seconds, t) : null;
  const probes = status.probes ?? [];

  const showMissingCta = !downloading && isLocalMode && missingCount > 0;
  const showLastUsed =
    !downloading && !showMissingCta && !!status.last_source_label && missingCount === 0;

  if (!downloading && !showMissingCta && !showLastUsed) {
    return null;
  }

  function copyDiagnostics() {
    const lines = [
      `platform: ${navigator.platform || "unknown"}`,
      `inference_mode: ${inferenceMode}`,
      `phase: ${status.phase}`,
      `source: ${status.active_source ?? status.last_source ?? "-"}`,
      `bps: ${status.download_bps ?? status.last_download_bps ?? "-"}`,
      `overall: ${status.overall_progress}% (${status.done_mb}/${status.total_mb} MB)`,
      ...status.models.map((m) => `model ${m.id}: ${m.status} ${m.progress}%`),
      ...(status.last_source_error ? [`last_error: ${status.last_source_error}`] : []),
      ...probes.map(
        (p) => `probe ${p.source}: ${p.ok ? `${p.bytes_per_second} B/s` : `fail ${p.error ?? ""}`}`,
      ),
    ];
    void navigator.clipboard?.writeText(lines.join("\n"));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  }

  function openDetails() {
    if (downloading) {
      setShowDetails(true);
    }
  }

  function pauseAndCloseDetails() {
    onPauseLocal();
    setShowDetails(false);
  }

  return (
    <>
      <div
        className={downloading ? "lm-dl-status is-active is-clickable" : "lm-dl-status"}
        title={downloading ? t("settings.models.localDownload.openDetails") : undefined}
        onClick={downloading ? openDetails : undefined}
      >
        <div className="lm-dl-status__row">
          <div className="lm-dl-status__main">
            {downloading ? (
              <>
                <span className="lm-dl-status__title">
                  {t("settings.models.localDownload.downloading")}
                </span>
                <span className="lm-dl-status__meta mono">
                  {[
                    status.source_label
                      ? t("localModel.downloading.source", { source: status.source_label })
                      : null,
                    speed,
                    eta ? t("home.continueRemaining", { remaining: eta }) : null,
                  ]
                    .filter(Boolean)
                    .join(" · ")}
                </span>
              </>
            ) : showMissingCta ? (
              <span className="lm-dl-status__title">
                {t("settings.models.localDownload.missing", { count: missingCount })}
              </span>
            ) : (
              <span className="lm-dl-status__note">
                {lastSpeed
                  ? t("settings.models.localDownload.lastUsed", {
                      source: status.last_source_label ?? "",
                      speed: lastSpeed,
                    })
                  : t("settings.models.localDownload.lastUsedNoSpeed", {
                      source: status.last_source_label ?? "",
                    })}
              </span>
            )}
          </div>
          <div className="lm-dl-status__actions">
            {downloading ? (
              <button
                type="button"
                className="btn btn-ghost sm"
                disabled={disabled || !status.can_pause}
                onClick={(event) => {
                  event.stopPropagation();
                  onPauseLocal();
                }}
              >
                {t("settings.models.localDownload.pause")}
              </button>
            ) : showMissingCta ? (
              <>
                <button
                  type="button"
                  className="btn btn-ghost sm"
                  disabled={disabled}
                  onClick={() => onRepairLocal()}
                >
                  {t("settings.models.localDownload.repair")}
                </button>
                <button
                  type="button"
                  className="btn btn-secondary sm"
                  disabled={disabled}
                  onClick={() => onDownloadLocal()}
                >
                  {t("settings.models.localDownload.prepareMissing")}
                </button>
              </>
            ) : null}
          </div>
        </div>
        {downloading ? (
          <span className="lm-track lm-dl-status__track">
            <span className="lm-fill" style={{ width: `${status.overall_progress}%` }} />
          </span>
        ) : null}
        {status.last_source_error && !downloading ? (
          <p className="lm-dl-status__error">{status.last_source_error}</p>
        ) : null}
        <div className="lm-dl-status__foot">
          <div className="lm-dl-status__links">
            {downloading ? (
              <button
                type="button"
                className="lm-dl-status__link"
                onClick={(event) => {
                  event.stopPropagation();
                  openDetails();
                }}
              >
                {t("settings.models.localDownload.openDetails")}
              </button>
            ) : null}
            {probes.length > 0 ? (
              <button
                type="button"
                className="lm-dl-status__link"
                onClick={(event) => {
                  event.stopPropagation();
                  setShowProbes((v) => !v);
                }}
              >
                {t("settings.models.localDownload.whyToggle")}
              </button>
            ) : null}
          </div>
          <button
            type="button"
            className="lm-dl-status__link"
            onClick={(event) => {
              event.stopPropagation();
              copyDiagnostics();
            }}
          >
            {copied
              ? t("settings.models.localDownload.copied")
              : t("settings.models.localDownload.copyDiagnostics")}
          </button>
        </div>
        {showProbes && probes.length > 0 ? (
          <div className="lm-dl-status__probes">
            {probes.map((p) => {
              const selected = p.source === (status.active_source ?? status.last_source);
              return (
                <div className="lm-dl-status__probe" key={p.source}>
                  <span>
                    {p.source}
                    {selected ? ` · ${t("settings.models.localDownload.probeSelected")}` : ""}
                  </span>
                  <span className={p.ok ? "mono" : "mono faint"}>
                    {p.ok
                      ? formatSpeed(p.bytes_per_second) ?? `${p.bytes_per_second} B/s`
                      : t("settings.models.localDownload.probeFailed")}
                  </span>
                </div>
              );
            })}
          </div>
        ) : null}
      </div>
      {showDetails && downloading ? (
        <LocalModelConsent
          capability={null}
          download={status}
          paused={false}
          onAgree={() => undefined}
          onDecline={() => setShowDetails(false)}
          onPause={pauseAndCloseDetails}
          onResume={() => onDownloadLocal()}
          onCancelDownload={pauseAndCloseDetails}
          onBackground={() => setShowDetails(false)}
        />
      ) : null}
    </>
  );
}

function ProviderConnections({
  capabilities,
  providers,
  error,
  disabled,
  onRefresh,
  requestConfirm,
  localPrep,
  onDownloadLocal,
  onPauseLocal,
  onRepairLocal,
  onDeleteLocal,
  inferenceMode,
}: {
  capabilities: CapabilityRowModel[];
  providers: api.ProviderRecord[];
  error: string | null;
  disabled: boolean;
  onRefresh: () => Promise<void>;
  requestConfirm: RequestConfirm;
  localPrep: api.LocalPrepareStatus | null;
  onDownloadLocal: (modelKey?: string) => void;
  onPauseLocal: () => void;
  onRepairLocal: (modelKey?: string) => void;
  onDeleteLocal: (modelKey: string) => void;
  inferenceMode: string;
}) {
  const t = useT();
  const typeLabel = (type: api.ProviderType) =>
    type === "openai"
      ? t("settings.models.providers.type.openai")
      : type === "gemini"
        ? t("settings.models.providers.type.gemini")
        : type === "openai-compatible"
          ? t("settings.models.providers.type.openaiCompatible")
          : type;
  const [mode, setMode] = useState<"create" | "edit" | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [form, setForm] = useState({
    type: "gemini" as RemoteProviderType,
    label: "Gemini",
    base_url: "",
    api_key: "",
  });
  const [action, setAction] = useState<{
    status: "idle" | "running" | "done" | "error";
    message: string | null;
  }>({ status: "idle", message: null });
  // Models discovered from a provider's /models endpoint, keyed by capability,
  // merged into that row's combobox options so users can pick a real model id.
  const [discovered, setDiscovered] = useState<Record<string, ModelComboOption[]>>({});
  const [discovering, setDiscovering] = useState<string | null>(null);
  const [discoverError, setDiscoverError] = useState<string | null>(null);

  async function exploreModels(cap: CapabilityRowModel) {
    if (!cap.provider) return;
    setDiscovering(cap.key);
    setDiscoverError(null);
    try {
      const models = await api.discoverProviderModels(cap.provider.id);
      setDiscovered((prev) => ({
        ...prev,
        [cap.key]: models.map((m) => ({ id: m.id, label: m.label || m.id, hint: m.source })),
      }));
    } catch (err) {
      setDiscoverError(errorMessage(err));
    } finally {
      setDiscovering(null);
    }
  }

  // The bundled local runtime ("Local on this Mac") is surfaced by the runtime
  // and Local model cards above — it is not a remote API key, so it does not
  // belong in this list. Show only genuinely remote provider connections here.
  const remoteProviders = providers.filter((provider) => provider.type !== "local");
  const editingProvider = editingId
    ? providers.find((provider) => provider.id === editingId) ?? null
    : null;

  // P3 · The connection editor is a focused modal now, so Esc dismisses it.
  useEscapeToClose(closeForm, mode !== null);
  const providerDialogRef = useRef<HTMLElement | null>(null);
  useDialogFocus(providerDialogRef, mode !== null);

  function openCreate() {
    setMode("create");
    setEditingId(null);
    setForm({
      type: "gemini",
      label: "Gemini",
      base_url: "",
      api_key: "",
    });
    setAction({ status: "idle", message: null });
  }

  function openEdit(provider: api.ProviderRecord) {
    if (provider.type === "local") {
      return;
    }
    setMode("edit");
    setEditingId(provider.id);
    setForm({
      type: provider.type,
      label: provider.label,
      base_url: provider.base_url ?? "",
      api_key: "",
    });
    setAction({ status: "idle", message: null });
  }

  function closeForm() {
    setMode(null);
    setEditingId(null);
    setAction({ status: "idle", message: null });
  }

  function updateType(type: RemoteProviderType) {
    const option = providerTypeOptions.find((item) => item.value === type);
    const defaultLabels = providerTypeOptions.map((item) => item.label);
    setForm((current) => ({
      ...current,
      type,
      label:
        !current.label.trim() || defaultLabels.includes(current.label)
          ? option?.label ?? current.label
          : current.label,
    }));
  }

  async function saveConnection(testAfterSave: boolean) {
    if (!mode) {
      return;
    }
    if (!form.label.trim()) {
      setAction({ status: "error", message: t("settings.models.providers.error.labelEmpty") });
      return;
    }
    if (form.type === "openai-compatible" && !form.base_url.trim()) {
      setAction({
        status: "error",
        message: t("settings.models.providers.error.baseUrlRequired"),
      });
      return;
    }

    setAction({
      status: "running",
      message: testAfterSave
        ? t("settings.models.providers.status.savingTesting")
        : t("settings.models.providers.status.saving"),
    });
    try {
      const apiKey = form.api_key.trim();
      const baseUrl = form.base_url.trim();
      const saved =
        mode === "create"
          ? await api.createProvider({
              type: form.type,
              label: form.label,
              ...(baseUrl ? { base_url: baseUrl } : {}),
              ...(apiKey ? { api_key: apiKey } : {}),
            })
          : await api.updateProvider(editingId ?? "", {
              label: form.label,
              base_url: baseUrl,
              ...(apiKey ? { api_key: apiKey } : {}),
            });
      const tested = testAfterSave ? await api.testProvider(saved.id) : saved;
      await onRefresh();
      setMode("edit");
      setEditingId(tested.id);
      setForm({
        type: tested.type === "local" ? form.type : tested.type,
        label: tested.label,
        base_url: tested.base_url ?? "",
        api_key: "",
      });
      setAction({
        status: tested.status === "error" ? "error" : "done",
        message: testAfterSave
          ? tested.last_error ??
            t("settings.models.providers.status.tested", {
              status:
                tested.status === "error"
                  ? t("settings.models.providers.status.failed")
                  : t("settings.models.providers.status.succeeded"),
            })
          : t("settings.models.providers.status.saved"),
      });
    } catch (err) {
      setAction({ status: "error", message: errorMessage(err) });
    }
  }

  async function removeConnection(provider: api.ProviderRecord) {
    if (provider.type === "local") {
      return;
    }
    const confirmed = await requestConfirm({
      title: t("settings.models.providers.confirm.title"),
      body: t("settings.models.providers.confirm.body", { label: provider.label }),
      confirmLabel: t("settings.models.providers.delete"),
    });
    if (!confirmed) {
      return;
    }
    setAction({ status: "running", message: t("settings.models.providers.status.deleting") });
    try {
      await api.deleteProvider(provider.id);
      if (editingId === provider.id) {
        closeForm();
      }
      await onRefresh();
      setAction({ status: "done", message: t("settings.models.providers.status.deleted") });
    } catch (err) {
      setAction({ status: "error", message: errorMessage(err) });
    }
  }

  const activeType = providerTypeOptions.find((item) => item.value === form.type);

  return (
    <section className="cap-list-shell">
      {error ? <InlineNotice tone="error" message={error} /> : null}
      {discoverError ? <InlineNotice tone="error" message={discoverError} /> : null}

      <LocalDownloadStatus
        localPrep={localPrep}
        inferenceMode={inferenceMode}
        capabilities={capabilities}
        disabled={disabled}
        onDownloadLocal={onDownloadLocal}
        onPauseLocal={onPauseLocal}
        onRepairLocal={onRepairLocal}
      />

      {/* One unified list: the three FIXED capabilities, each carrying its model
          and the connection + key it routes through, handled together. */}
      <div className="cap-list">
        {capabilities.map((cap) => {
          const provider = cap.provider;
          const hasKey = provider?.has_key ?? false;
          // A saved key whose last connection test failed (backend persists
          // status "error" + last_error) is not actually ready — don't show it
          // as a green success row.
          const failed = !cap.isLocal && provider?.status === "error";
          // On-device rows show the REAL weight-download state (未下载 / 下载中 /
          // 就绪) from the live prepare-status — not a blanket "ready" just
          // because local mode is selected.
          const localModel =
            cap.isLocal && cap.localModelKey
              ? localPrep?.models.find((m) => m.id === cap.localModelKey) ?? null
              : null;
          // "ready" | "downloading" | "pending" | "unknown" (core not reached yet)
          const localState = cap.isLocal
            ? localModel
              ? localModel.status
              : "unknown"
            : null;
          const ready = cap.isLocal ? localState === "ready" : hasKey && !failed;
          const host = provider?.base_url
            ? provider.base_url.replace(/^https?:\/\//, "").replace(/\/.*$/, "")
            : "";
          const serviceLine = cap.isLocal
            ? t("settings.models.capability.localRuntime")
            : [
                provider ? typeLabel(provider.type) : null,
                host || null,
                // The status chip on the right already says "key needed";
                // repeating it here read as two warnings per row.
                hasKey ? t("settings.models.capability.hasKey") : null,
              ]
                .filter(Boolean)
                .join(" · ");
          return (
            <article className="cap-row" key={cap.key}>
              <span className="cap-row__badge" aria-hidden="true">
                {cap.badge}
              </span>
              <div className="cap-row__body">
                <div className="cap-row__top">
                  <span className="cap-row__name">{cap.name}</span>
                  <span className="cap-row__actions">
                    <span
                      className={
                        failed
                          ? "chip danger"
                          : ready
                            ? "chip success"
                            : localState === "downloading"
                              ? "chip warn"
                              : cap.isLocal
                                ? "chip neutral"
                                : "chip warn"
                      }
                      title={failed ? provider?.last_error ?? undefined : undefined}
                    >
                      <span className="dot" />
                      {failed
                        ? t("settings.models.capability.failed")
                        : cap.isLocal
                          ? localState === "ready"
                            ? t("settings.models.capability.ready")
                            : localState === "downloading"
                              ? `${t("localModel.status.downloading")} ${localModel?.progress ?? 0}%`
                              : localState === "unknown"
                                ? t("settings.models.capability.checking")
                                : t("settings.models.capability.notDownloaded")
                          : ready
                            ? t("settings.models.capability.ready")
                            : t("settings.models.capability.needsKey")}
                    </span>
                    {cap.isLocal ? (
                      cap.localModelKey && (localState === "pending" || localState === "unknown") ? (
                        <button
                          type="button"
                          className="btn btn-ghost sm cap-row__edit"
                          disabled={disabled}
                          onClick={() => onDownloadLocal(cap.localModelKey ?? undefined)}
                        >
                          {t("settings.models.capability.download")}
                        </button>
                      ) : cap.localModelKey && localState === "ready" ? (
                        <button
                          type="button"
                          className="btn btn-ghost sm cap-row__edit"
                          disabled={disabled}
                          onClick={() => onDeleteLocal(cap.localModelKey as string)}
                        >
                          {t("settings.models.localDownload.delete")}
                        </button>
                      ) : null
                    ) : (
                      <button
                        type="button"
                        className="btn btn-ghost sm cap-row__edit"
                        disabled={disabled}
                        onClick={() => (provider ? openEdit(provider) : openCreate())}
                      >
                        {t("settings.models.capability.edit")}
                      </button>
                    )}
                  </span>
                </div>
                <div className="cap-row__bottom">
                  <div className="cap-row__model">
                    {cap.locked ? (
                      <span className="cap-row__locked">
                        <Lock size={12} />
                        <span className="cap-row__model-val">{cap.modelValue}</span>
                        {cap.note ? <span className="chip neutral">{cap.note}</span> : null}
                      </span>
                    ) : !cap.modelEditable ? (
                      <span className="cap-row__model-val cap-row__model-fixed">
                        {cap.localLabel}
                      </span>
                    ) : (
                      <ModelCombobox
                        value={cap.modelValue}
                        options={mergeComboOptions(cap.modelOptions, discovered[cap.key])}
                        disabled={disabled}
                        busy={discovering === cap.key}
                        onSelect={(id) => cap.onSelectModel?.(id)}
                        onExplore={
                          cap.provider && !cap.isLocal ? () => void exploreModels(cap) : undefined
                        }
                        ariaLabel={cap.name}
                      />
                    )}
                  </div>
                  <span className="cap-row__service">{serviceLine}</span>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      <p className="model-advanced-footnote">{t("settings.models.advanced.footnote")}</p>

      {mode ? (
        <div className="scrim" role="presentation" onMouseDown={closeForm}>
          <section
            ref={providerDialogRef}
            className="dialog provider-conn-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="provider-conn-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <header className="dhead">
              <div>
                <p className="section-label">{t("settings.models.providers.kicker")}</p>
                <h2 id="provider-conn-title" className="dtitle">
                  {mode === "create"
                    ? t("settings.models.providers.add")
                    : t("settings.models.providers.edit")}
                </h2>
              </div>
              <button
                type="button"
                className="btn-icon"
                aria-label={t("common.close")}
                onClick={closeForm}
              >
                <X size={16} />
              </button>
            </header>
            <form
              className="provider-form provider-conn-dialog__form"
              onSubmit={(event) => {
                event.preventDefault();
                void saveConnection(false);
              }}
            >
          <div className="provider-form-grid">
            <label>
              <span>{t("settings.models.providers.form.type")}</span>
              <select
                className="select"
                value={form.type}
                disabled={disabled || mode === "edit"}
                onChange={(event) => updateType(event.currentTarget.value as RemoteProviderType)}
              >
                {providerTypeOptions.map((option) => (
                  <option key={option.value} value={option.value}>
                    {option.label}
                  </option>
                ))}
              </select>
            </label>
            <label>
              <span>{t("settings.models.providers.form.label")}</span>
              <input
                value={form.label}
                disabled={disabled}
                onChange={(event) => setForm((current) => ({ ...current, label: event.currentTarget.value }))}
              />
            </label>
            <label>
              <span>{t("settings.models.providers.form.baseUrl")}</span>
              <input
                value={form.base_url}
                disabled={disabled}
                placeholder={activeType?.placeholder}
                onChange={(event) => setForm((current) => ({ ...current, base_url: event.currentTarget.value }))}
              />
              <small>
                {form.type === "openai-compatible"
                  ? t("settings.models.providers.form.baseUrlHelp.required")
                  : t("settings.models.providers.form.baseUrlHelp.optional")}
              </small>
            </label>
            <label>
              <span>{t("settings.models.providers.form.apiKey")}</span>
              <input
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={form.api_key}
                disabled={disabled}
                placeholder={mode === "edit" ? t("settings.models.providers.form.apiKeyPlaceholder") : ""}
                onChange={(event) => setForm((current) => ({ ...current, api_key: event.currentTarget.value }))}
              />
              {mode === "edit" && editingProvider?.key_preview ? (
                <small className="field-hint">
                  {t("settings.models.providers.form.currentKey", {
                    preview: editingProvider.key_preview,
                  })}
                </small>
              ) : null}
            </label>
          </div>
          {action.message ? (
            <InlineNotice
              tone={action.status === "error" ? "error" : "muted"}
              message={action.message}
            />
          ) : null}
          <div className="provider-form-actions">
            <button
              type="submit"
              className="btn btn-primary sm"
              disabled={disabled || action.status === "running"}
            >
              <Check size={16} />
              <span>{t("settings.models.providers.form.save")}</span>
            </button>
            <button
              type="button"
              className="btn btn-secondary sm"
              disabled={disabled || action.status === "running"}
              onClick={() => void saveConnection(true)}
            >
              <RefreshCcw size={16} />
              <span>{t("settings.models.providers.form.test")}</span>
            </button>
            <button type="button" className="btn btn-ghost sm" onClick={closeForm}>
              {t("settings.models.providers.form.cancel")}
            </button>
          </div>
            </form>
          </section>
        </div>
      ) : null}
    </section>
  );
}

function providerStatusLabel(status: api.ProviderRecord["status"], t: TFunction) {
  if (status === "ready") {
    return t("settings.models.providers.status.ready");
  }
  if (status === "error") {
    return t("settings.models.providers.status.error");
  }
  return t("settings.models.providers.status.unconfigured");
}

function ScanThisMacControl({ disabled }: { disabled: boolean }) {
  const t = useT();
  const FOLDERS: { labelKey: string; path: string }[] = [
    { labelKey: "settings.indexing.scan.folder.movies", path: "~/Movies" },
    { labelKey: "settings.indexing.scan.folder.downloads", path: "~/Downloads" },
    { labelKey: "settings.indexing.scan.folder.desktop", path: "~/Desktop" },
    { labelKey: "settings.indexing.scan.folder.documents", path: "~/Documents" },
    { labelKey: "settings.indexing.scan.folder.pictures", path: "~/Pictures" },
  ];
  const [selected, setSelected] = useState<Set<string>>(new Set(["~/Movies", "~/Downloads"]));
  const [state, setState] = useState<"idle" | "running" | "done" | "error">("idle");
  const [report, setReport] = useState<string | null>(null);

  function toggle(path: string) {
    setSelected((current) => {
      const next = new Set(current);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  async function scanNow() {
    if (selected.size === 0) return;
    setState("running");
    setReport(null);
    const errors: string[] = [];
    let added = 0;
    for (const path of selected) {
      try {
        await api.addSource("folder_video", { path });
        added += 1;
      } catch (err) {
        errors.push(`${path}: ${errorMessage(err)}`);
      }
    }
    setState(errors.length > 0 ? "error" : "done");
    setReport(
      errors.length > 0
        ? `${t("settings.indexing.scan.report.partial", { added, failed: errors.length })}\n${errors.join("\n")}`
        : t("settings.indexing.scan.report.done", { added }),
    );
  }

  return (
    <div className="settings-stack-control">
      <div className="folder-list">
        {FOLDERS.map((folder) => {
          const on = selected.has(folder.path);
          return (
            <button
              key={folder.path}
              type="button"
              className={on ? "folder-row on" : "folder-row"}
              disabled={disabled || state === "running"}
              aria-pressed={on}
              onClick={() => toggle(folder.path)}
            >
              <span className="folder-check" aria-hidden="true">
                {on ? <Check size={13} /> : null}
              </span>
              <Folder size={15} className="folder-glyph" />
              <span className="folder-name">{t(folder.labelKey)}</span>
              <span className="folder-path mono">{folder.path}</span>
            </button>
          );
        })}
      </div>
      <button
        type="button"
        className="btn btn-secondary sm"
        disabled={disabled || state === "running" || selected.size === 0}
        onClick={() => void scanNow()}
      >
        {state === "running"
          ? t("settings.indexing.scan.adding")
          : t("settings.indexing.scan.addButton", { count: selected.size })}
      </button>
      {report ? <p className="settings-help">{report}</p> : null}
    </div>
  );
}

function UsageValue({
  totals,
  fallback,
}: {
  totals: api.UsageTotals | null | undefined;
  fallback: string;
}) {
  const t = useT();
  if (!totals || totals.event_count === 0) {
    return <span className="settings-value muted">{fallback}</span>;
  }
  const details = [
    totals.audio_seconds > 0 ? formatDuration(totals.audio_seconds) : null,
    totals.image_count > 0
      ? t(totals.image_count === 1 ? "jobs.usage.images.one" : "jobs.usage.images.other", {
          count: totals.image_count,
        })
      : null,
    totals.input_tokens > 0
      ? t("jobs.usage.inputTokens", { count: totals.input_tokens.toLocaleString(appLocaleTag()) })
      : null,
    totals.unpriced_events > 0 ? t("jobs.usage.unpriced", { count: totals.unpriced_events }) : null,
  ].filter(Boolean);

  return (
    <span className="settings-value">
      {formatUsd(totals.estimated_usd)}
      {details.length > 0 ? <small>{details.join(" · ")}</small> : null}
    </span>
  );
}

function storageCategoryLabel(key: string, fallback: string, t: TFunction) {
  const labels: Record<string, string> = {
    database: t("settings.storage.category.database"),
    models: t("settings.storage.category.models"),
    index: t("settings.storage.category.index"),
    cache: t("settings.storage.category.cache"),
    other: t("settings.storage.category.other"),
  };
  return labels[key] ?? fallback;
}

function StorageSettings({
  requestConfirm,
}: {
  requestConfirm: RequestConfirm;
}) {
  const t = useT();
  const [locations, setLocations] = useState<StorageLocations | null>(null);
  const [usage, setUsage] = useState<api.StorageUsageResponse | null>(null);
  const [action, setAction] = useState<{
    status: SettingsActionStatus;
    message: string | null;
  }>({ status: "idle", message: null });
  const busy = action.status === "running";
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loadAttempt, setLoadAttempt] = useState(0);

  useEffect(() => {
    let cancelled = false;
    setLoadError(null);
    void Promise.all([readStorageLocations(), api.storageUsage()])
      .then(([locationsValue, usageValue]) => {
        if (!cancelled) {
          setLocations(locationsValue);
          setUsage(usageValue);
        }
      })
      .catch((error) => {
        // Surface the failure with a retry; the row otherwise sits on
        // "loading" forever.
        if (!cancelled) {
          setLoadError(errorMessage(error));
        }
      });
    return () => {
      cancelled = true;
    };
  }, [loadAttempt]);

  async function refreshStorageUsage() {
    try {
      setUsage(await api.storageUsage());
    } catch (error) {
      console.warn("failed to refresh Cerul storage usage", error);
    }
  }

  async function runStorageAction(actionName: "reveal-data" | "clear-cache") {
    setAction({ status: "running", message: null });
    try {
      if (actionName === "reveal-data") {
        await revealDataDirectory();
        setAction({ status: "done", message: t("settings.storage.message.dataOpened") });
        return;
      }
      if (actionName === "clear-cache") {
        const result = await clearCacheDirectory();
        setAction({
          status: "done",
          message: t("settings.storage.message.cacheCleared", { size: formatBytes(result.bytes_removed) }),
        });
        await refreshStorageUsage();
        return;
      }
    } catch (error) {
      setAction({ status: "error", message: errorMessage(error) });
    }
  }

  async function resetAllLocalData() {
    const confirmed = await requestConfirm({
      title: t("settings.storage.reset.confirm.title"),
      body: t("settings.storage.reset.confirm.body"),
      confirmLabel: t("settings.storage.reset.confirm.label"),
    });
    if (!confirmed) {
      return;
    }
    setAction({ status: "running", message: t("settings.storage.message.resetStarting") });
    try {
      await resetLocalDataAndRestart();
    } catch (error) {
      setAction({ status: "error", message: errorMessage(error) });
    }
  }

  return (
    <>
      {loadError ? (
        <InlineNotice
          tone="error"
          message={loadError}
          action={{
            label: t("common.retry"),
            onClick: () => setLoadAttempt((attempt) => attempt + 1),
          }}
        />
      ) : null}
      <SettingsGroup title={t("settings.storage.group.title")}>
        <SettingRow
          label={t("settings.storage.dataDir.label")}
          control={
            <div className="settings-inline-action">
              <code>{locations?.data_dir ?? "~/Library/Application Support/Cerul"}</code>
              <button
                className="btn btn-secondary sm"
                type="button"
                disabled={busy}
                onClick={() => void runStorageAction("reveal-data")}
              >
                <Folder size={16} />
                <span>{t("settings.storage.dataDir.reveal")}</span>
              </button>
            </div>
          }
        />
        <SettingRow
          label={t("settings.storage.cacheSize.label")}
          control={
            <span className="settings-value">
              {usage ? formatBytes(usage.total_bytes) : t("settings.storage.dataDirLoading")}
            </span>
          }
        />
        {usage ? (
          <div className="storage-breakdown">
            {usage.categories.map((category) => {
              const pct =
                usage.total_bytes > 0
                  ? Math.min(100, Math.round((category.bytes / usage.total_bytes) * 100))
                  : 0;
              return (
                <div className="storage-row" key={category.key}>
                  <div className="row" style={{ justifyContent: "space-between" }}>
                    <span>{storageCategoryLabel(category.key, category.label, t)}</span>
                    <span className="mono faint">{formatBytes(category.bytes)}</span>
                  </div>
                  <ProgressBar value={pct} />
                </div>
              );
            })}
          </div>
        ) : null}
      </SettingsGroup>
      <div className="settings-actions">
        <button
          className="btn btn-secondary sm"
          type="button"
          disabled={busy}
          onClick={() => void runStorageAction("clear-cache")}
        >
          {busy ? <Loader2 size={16} /> : <HardDrive size={16} />}
          <span>{t("settings.storage.clearCache")}</span>
        </button>
        <button
          className="btn btn-danger sm"
          type="button"
          disabled={busy || !hasDesktopHost()}
          onClick={() => void resetAllLocalData()}
        >
          {busy ? <Loader2 size={16} /> : <Trash2 size={16} />}
          <span>{t("settings.storage.resetLocalData")}</span>
        </button>
      </div>
      {action.message ? (
        <InlineNotice tone={action.status === "error" ? "error" : "muted"} message={action.message} />
      ) : null}
    </>
  );
}

function AdvancedSettings({
  settings,
  disabled,
  onSettingsChange,
}: {
  settings: api.SettingsMap;
  disabled: boolean;
  onSettingsChange: (settings: api.SettingsMap) => Promise<void>;
}) {
  const t = useT();
  const binding = settingString(settings, "api_binding", "127");
  // The key itself is write-only on the API; we only learn whether one exists.
  const remoteApiKeySet = settings["remote_api_key_set"] === true;
  const [remoteKeyDraft, setRemoteKeyDraft] = useState("");
  const logLevel = settingString(settings, "log_level", "info");
  const modelDownloadSource = settingString(settings, "model_download_source", "auto");
  const [logAction, setLogAction] = useState<{
    status: SettingsActionStatus;
    message: string | null;
  }>({ status: "idle", message: null });
  const [diagnosticBundleAction, setDiagnosticBundleAction] = useState<{
    status: SettingsActionStatus;
    message: string | null;
  }>({ status: "idle", message: null });
  const [telemetryExpanded, setTelemetryExpanded] = useState(false);

  async function openLogsFolder() {
    setLogAction({ status: "running", message: null });
    try {
      await revealLogsDirectory();
      setLogAction({ status: "done", message: t("settings.advanced.message.logsOpened") });
    } catch (error) {
      setLogAction({ status: "error", message: errorMessage(error) });
    }
  }

  async function copyDiagnosticBundle() {
    setDiagnosticBundleAction({ status: "running", message: null });
    try {
      const diagnostics = await api.diagnosticsBundle();
      await navigator.clipboard.writeText(JSON.stringify(diagnostics, null, 2));
      setDiagnosticBundleAction({
        status: "done",
        message: t("settings.advanced.message.diagnosticsCopied"),
      });
    } catch (error) {
      setDiagnosticBundleAction({ status: "error", message: errorMessage(error) });
    }
  }

  return (
    <>
      <SettingsGroup title={t("settings.advanced.localApi.title")}>
        <SettingRow
          label={t("settings.advanced.binding.label")}
          description={t("settings.advanced.binding.description")}
          control={
            <select
              className="select"
              value={binding}
              disabled={disabled}
              onChange={(event) => void onSettingsChange({ api_binding: event.currentTarget.value })}
            >
              <option value="127">{t("settings.advanced.binding.localOnly")}</option>
              <option value="0">{t("settings.advanced.binding.allInterfaces")}</option>
            </select>
          }
        />
        {binding === "0" ? (
          <SettingRow
            label={t("settings.advanced.remoteKey.label")}
            description={remoteApiKeySet ? t("settings.advanced.remoteKey.setHint") : undefined}
            control={
              <input
                className="settings-input"
                type="password"
                value={remoteKeyDraft}
                disabled={disabled}
                placeholder={
                  remoteApiKeySet
                    ? t("settings.advanced.remoteKey.placeholderSet")
                    : t("settings.advanced.remoteKey.placeholder")
                }
                onChange={(event) => setRemoteKeyDraft(event.currentTarget.value)}
                onBlur={() => {
                  if (remoteKeyDraft.trim().length === 0) return;
                  void onSettingsChange({ remote_api_key: remoteKeyDraft });
                  setRemoteKeyDraft("");
                }}
              />
            }
          />
        ) : null}
      </SettingsGroup>
      <SettingsGroup title={t("settings.advanced.privacy.title")}>
        <SettingRow
          label={t("settings.advanced.telemetry.label")}
          description={t("settings.advanced.telemetry.description")}
          control={
            <div className="settings-stack-control">
              <Toggle
                checked={settingBoolean(settings, "telemetry", false)}
                disabled={disabled}
                onChange={(checked) => void onSettingsChange({ telemetry: checked })}
              />
              <button
                className="btn btn-ghost sm"
                type="button"
                aria-expanded={telemetryExpanded}
                onClick={() => setTelemetryExpanded((expanded) => !expanded)}
              >
                {t("settings.advanced.telemetry.detailsToggle")}
              </button>
              {telemetryExpanded ? (
                <p className="settings-help">{t("settings.advanced.telemetry.detailsBody")}</p>
              ) : null}
            </div>
          }
        />
      </SettingsGroup>
      <SettingsGroup title={t("settings.advanced.modelDownload.title")}>
        <SettingRow
          label={t("settings.advanced.modelDownload.source.label")}
          description={t("settings.advanced.modelDownload.source.description")}
          control={
            <select
              value={modelDownloadSource}
              disabled={disabled}
              onChange={(event) =>
                void onSettingsChange({ model_download_source: event.currentTarget.value })
              }
            >
              <option value="auto">{t("settings.advanced.modelDownload.source.auto")}</option>
              <option value="huggingface">{t("settings.advanced.modelDownload.source.huggingface")}</option>
              <option value="modelscope">{t("settings.advanced.modelDownload.source.modelscope")}</option>
              <option value="cerul_cdn">{t("settings.advanced.modelDownload.source.cerulCdn")}</option>
            </select>
          }
        />
      </SettingsGroup>
      <SettingsGroup title={t("settings.advanced.diagnostics.title")}>
        <SettingRow
          label={t("settings.advanced.logLevel.label")}
          control={
            <select
              value={logLevel}
              disabled={disabled}
              onChange={(event) => void onSettingsChange({ log_level: event.currentTarget.value })}
            >
              <option value="info">{t("settings.advanced.logLevel.info")}</option>
              <option value="debug">{t("settings.advanced.logLevel.debug")}</option>
            </select>
          }
        />
      </SettingsGroup>
      <div className="settings-actions">
        <button
          className="btn btn-secondary sm"
          type="button"
          disabled={logAction.status === "running"}
          onClick={() => void openLogsFolder()}
        >
          {logAction.status === "running" ? <Loader2 size={16} /> : <Folder size={16} />}
          <span>{t("settings.advanced.openLogs")}</span>
        </button>
        <button
          className="btn btn-secondary sm"
          type="button"
          disabled={diagnosticBundleAction.status === "running"}
          onClick={() => void copyDiagnosticBundle()}
        >
          {diagnosticBundleAction.status === "running" ? <Loader2 size={16} /> : <Copy size={16} />}
          <span>{t("settings.advanced.copyDiagnostics")}</span>
        </button>
        <button
          className="btn btn-secondary sm"
          type="button"
          onClick={() => {
            // Route straight to the onboarding wizard via the hash. The previous
            // version only persisted the route and reloaded, but the reload kept
            // the current #settings hash — which takes priority on launch — so the
            // button appeared to do nothing. Setting the hash before reloading is
            // what actually navigates (and the reload resets the wizard to step 0).
            window.location.hash = routeHash("onboarding");
            window.location.reload();
          }}
        >
          <RefreshCcw size={16} />
          <span>{t("settings.advanced.rerunOnboarding")}</span>
        </button>
      </div>
      {logAction.message ? (
        <InlineNotice
          tone={logAction.status === "error" ? "error" : "muted"}
          message={logAction.message}
        />
      ) : null}
      {diagnosticBundleAction.message ? (
        <InlineNotice
          tone={diagnosticBundleAction.status === "error" ? "error" : "muted"}
          message={diagnosticBundleAction.message}
        />
      ) : null}
    </>
  );
}

// F5 · Account & Usage. Spend, on-device/cloud split, and per-capability
// breakdown come from the local usageSummary endpoint.
function UsageSettings() {
  const t = useT();
  const [summary, setSummary] = useState<api.UsageSummary | null>(null);
  const [error, setError] = useState<string | null>(null);
  const user = useAuthStore((state) => state.user);
  const status = useAuthStore((state) => state.status);
  const signedIn = status === "signedIn" && !!user;

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const next = await api.usageSummary();
        if (active) {
          setSummary(next);
        }
      } catch (err) {
        if (active) {
          setError(errorMessage(err));
        }
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const total = summary?.total.estimated_usd ?? 0;
  const events = summary?.total.event_count ?? 0;
  const localEvents = summary?.local.event_count ?? 0;
  const remoteEvents = summary?.remote.event_count ?? 0;
  const localShare = events > 0 ? Math.round((localEvents / events) * 100) : 0;

  return (
    <section className="usage-settings">
      <p className="settings-help">{t("settings.usage.desc")}</p>
      {error ? <InlineNotice tone="error" message={error} /> : null}
      <div className="usage-cards">
        <div className="usage-card">
          <span className="usage-card__label">{t("settings.usage.account.label")}</span>
          {signedIn && user ? (
            <>
              <strong className="usage-card__value">{user.email}</strong>
              <span className="chip neutral">{t(`settings.account.plan.${user.plan}`)}</span>
            </>
          ) : (
            <>
              <p className="usage-card__note">{t("settings.usage.account.signedOut")}</p>
              <button
                type="button"
                className="btn btn-primary sm"
                onClick={() => window.dispatchEvent(new Event("cerul:open-account"))}
              >
                {t("settings.account.signIn")}
              </button>
            </>
          )}
        </div>
        <div className="usage-card">
          <span className="usage-card__label">{t("settings.usage.spend.label")}</span>
          <strong className="usage-card__value mono">{formatUsd(total)}</strong>
          <span className="usage-card__note">{t("settings.usage.spend.events", { count: events })}</span>
        </div>
      </div>
      <div className="usage-split">
        <div className="usage-split__head">
          <span className="usage-card__label">{t("settings.usage.split.label")}</span>
          <span className="mono">{t("settings.usage.split.value", { pct: localShare })}</span>
        </div>
        <div className="usage-split__bar" aria-hidden="true">
          <div style={{ width: `${localShare}%` }} />
        </div>
        <div className="usage-split__legend">
          <span>{t("settings.usage.split.local", { count: localEvents })}</span>
          <span>{t("settings.usage.split.cloud", { count: remoteEvents })}</span>
        </div>
      </div>
      {summary?.by_capability.length ? (
        <div className="usage-breakdown">
          <span className="usage-card__label">{t("settings.usage.breakdown.label")}</span>
          {summary.by_capability.map((row) => (
            <div className="usage-breakdown__row" key={row.key}>
              <span>{t(`usage.capability.${row.key}`)}</span>
              <span className="mono">{formatUsd(row.totals.estimated_usd)}</span>
              <span className="mono faint">{t("settings.usage.spend.events", { count: row.totals.event_count })}</span>
            </div>
          ))}
        </div>
      ) : null}
    </section>
  );
}

function AboutSettings() {
  const t = useT();
  type AvailableDesktopUpdate = Exclude<DesktopUpdate, null>;
  const [appVersion, setAppVersion] = useState<string | null>(null);
  const [updateState, setUpdateState] = useState<{
    status: SettingsActionStatus;
    message: string | null;
    update: AvailableDesktopUpdate | null;
  }>({ status: "idle", message: null, update: null });
  const [diagnosticsState, setDiagnosticsState] = useState<{
    status: SettingsActionStatus;
    message: string | null;
  }>({ status: "idle", message: null });
  const [aboutUpdaterState, setAboutUpdaterState] = useState<DesktopUpdaterState>({ phase: "idle" });
  const [updateActionStatus, setUpdateActionStatus] = useState<SettingsActionStatus>("idle");
  const lastManualUpdateCheckAt = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void getDesktopAppVersion()
      .then((version) => {
        if (!cancelled) {
          setAppVersion(version);
        }
      })
      .catch(() => {
        if (!cancelled) {
          setAppVersion(null);
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    if (!hasDesktopHost()) {
      return;
    }
    const unsubscribe = subscribeDesktopUpdater(setAboutUpdaterState);
    void getDesktopUpdaterState().then(setAboutUpdaterState).catch(() => undefined);
    return unsubscribe;
  }, []);

  async function checkForUpdates() {
    const now = Date.now();
    if (now - lastManualUpdateCheckAt.current < manualUpdateCheckCooldownMs) {
      return;
    }
    lastManualUpdateCheckAt.current = now;
    setUpdateState({ status: "running", message: null, update: null });
    try {
      const update = await checkForDesktopUpdate();
      if (hasDesktopHost()) {
        const next = await runDesktopUpdaterCheck();
        setAboutUpdaterState(next);
      }
      setUpdateState({
        status: "done",
        message: update
          ? t("settings.about.update.ready", { version: update.version })
          : t("settings.about.update.upToDate"),
        update,
      });
    } catch (error) {
      setUpdateState({ status: "error", message: errorMessage(error), update: null });
    }
  }

  async function activateCheckedUpdate() {
    const update = updateState.update;
    if (!update) {
      return;
    }
    if (!hasDesktopHost()) {
      window.open(update.url, "_blank", "noopener,noreferrer");
      return;
    }
    setUpdateActionStatus("running");
    try {
      let next = await getDesktopUpdaterState();
      setAboutUpdaterState(next);
      if (next.phase === "idle" || next.phase === "error") {
        next = await runDesktopUpdaterCheck();
        setAboutUpdaterState(next);
      }
      if (next.phase === "downloaded") {
        setAboutUpdaterState({ phase: "installing", version: next.version });
        await installDesktopUpdate();
        return;
      }
      if (next.phase === "available") {
        const downloaded = await downloadDesktopUpdate();
        setAboutUpdaterState(downloaded);
        if (downloaded.phase === "idle") {
          window.open(update.url, "_blank", "noopener,noreferrer");
        }
        return;
      }
      if (next.phase === "downloading" || next.phase === "installing") {
        return;
      }
      window.open(update.url, "_blank", "noopener,noreferrer");
    } catch (error) {
      setUpdateState({
        status: "error",
        message: errorMessage(error),
        update,
      });
    } finally {
      setUpdateActionStatus("idle");
    }
  }

  function updateActionLabel() {
    if (updateActionStatus === "running") {
      return t("settings.about.update.download");
    }
    if (aboutUpdaterState.phase === "downloading") {
      return t("settings.about.update.downloading");
    }
    if (aboutUpdaterState.phase === "downloaded") {
      return t("settings.about.update.restart");
    }
    if (aboutUpdaterState.phase === "installing") {
      return t("settings.about.update.installing");
    }
    return t("settings.about.update.download");
  }

  function updateActionIcon() {
    if (
      updateActionStatus === "running" ||
      aboutUpdaterState.phase === "downloading" ||
      aboutUpdaterState.phase === "installing"
    ) {
      return <Loader2 size={16} />;
    }
    if (aboutUpdaterState.phase === "downloaded") {
      return <RefreshCcw size={16} />;
    }
    return <Download size={16} />;
  }

  async function copyUpdateDiagnostics() {
    setDiagnosticsState({ status: "running", message: null });
    try {
      const diagnostics = await getDesktopUpdaterDiagnostics();
      if (!diagnostics) {
        throw new Error(t("settings.about.update.diagnosticsUnavailable"));
      }
      await navigator.clipboard.writeText(diagnostics);
      setDiagnosticsState({
        status: "done",
        message: t("settings.about.update.diagnosticsCopied"),
      });
    } catch (error) {
      setDiagnosticsState({ status: "error", message: errorMessage(error) });
    }
  }

  return (
    <>
      <SettingsGroup title={t("settings.about.group.title")}>
        <SettingRow
          label={t("settings.about.version.label")}
          control={<span className="settings-value">{appVersion ?? t("settings.about.version.fallback")}</span>}
        />
        <SettingRow
          label={t("settings.about.license.label")}
          control={<span className="settings-value">{t("settings.about.license.value")}</span>}
        />
        <SettingRow
          label={t("settings.about.commit.label")}
          control={<span className="settings-value">{t("settings.about.commit.value")}</span>}
        />
        <SettingRow
          label={t("settings.about.buildDate.label")}
          control={<span className="settings-value">{t("settings.about.buildDate.value")}</span>}
        />
      </SettingsGroup>
      <div className="settings-actions">
        <button
          className="btn btn-secondary sm"
          type="button"
          onClick={() => window.open("https://github.com/cerul-ai/cerul-app", "_blank", "noopener,noreferrer")}
        >
          <ExternalLink size={16} />
          <span>{t("settings.about.github")}</span>
        </button>
        <button
          className="btn btn-secondary sm"
          type="button"
          onClick={() => window.open("https://cerul.ai/docs", "_blank", "noopener,noreferrer")}
        >
          <ExternalLink size={16} />
          <span>{t("settings.about.docs")}</span>
        </button>
        <button
          className="btn btn-secondary sm"
          type="button"
          onClick={() => window.open("mailto:support@cerul.ai", "_blank", "noopener,noreferrer")}
        >
          <ExternalLink size={16} />
          <span>{t("settings.about.support")}</span>
        </button>
        <button
          className="btn btn-secondary sm"
          type="button"
          disabled={updateState.status === "running"}
          onClick={() => void checkForUpdates()}
        >
          {updateState.status === "running" ? <Loader2 size={16} /> : <RefreshCcw size={16} />}
          <span>{t("settings.about.checkUpdates")}</span>
        </button>
        {hasDesktopHost() ? (
          <button
            className="btn btn-secondary sm"
            type="button"
            disabled={diagnosticsState.status === "running"}
            onClick={() => void copyUpdateDiagnostics()}
          >
            {diagnosticsState.status === "running" ? <Loader2 size={16} /> : <Copy size={16} />}
            <span>{t("settings.about.update.copyDiagnostics")}</span>
          </button>
        ) : null}
        {updateState.update ? (
          <button
            className="btn btn-primary sm"
            type="button"
            disabled={
              updateActionStatus === "running" ||
              aboutUpdaterState.phase === "downloading" ||
              aboutUpdaterState.phase === "installing"
            }
            onClick={() => void activateCheckedUpdate()}
          >
            {updateActionIcon()}
            <span>{updateActionLabel()}</span>
          </button>
        ) : null}
        {updateState.update ? (
          <button
            className="btn btn-secondary sm"
            type="button"
            onClick={() => window.open(updateState.update!.url, "_blank", "noopener,noreferrer")}
          >
            <ExternalLink size={16} />
            <span>{t("settings.about.update.openRelease")}</span>
          </button>
        ) : null}
      </div>
      {updateState.message ? (
        <InlineNotice
          tone={updateState.status === "error" ? "error" : "muted"}
          message={updateState.message}
        />
      ) : null}
      {diagnosticsState.message ? (
        <InlineNotice
          tone={diagnosticsState.status === "error" ? "error" : "muted"}
          message={diagnosticsState.message}
        />
      ) : null}
    </>
  );
}

function SettingRow({
  label,
  description,
  control,
  stacked = false,
}: {
  label: string;
  description?: string;
  control: ReactNode;
  stacked?: boolean;
}) {
  return (
    <div className={stacked ? "setting-row setting-row-stacked" : "setting-row"}>
      <div className="setting-row-label">
        <span>{label}</span>
        {description ? <small>{description}</small> : null}
      </div>
      <div className="setting-row-control">{control}</div>
    </div>
  );
}

function SettingsGroup({ title, children }: { title?: string; children: ReactNode }) {
  return (
    <section className="settings-group">
      {title ? <p className="settings-group-title">{title}</p> : null}
      <div className="settings-group-rows">{children}</div>
    </section>
  );
}

function Segmented({
  values,
  value,
  disabled = false,
  labels,
  onChange,
}: {
  values: string[];
  value: string;
  disabled?: boolean;
  /** Display label per stored value — stored values stay stable (e.g. "Dark"). */
  labels?: Record<string, string>;
  onChange: (value: string) => void;
}) {
  return (
    <div className="segmented">
      {values.map((option) => (
        <button
          key={option}
          type="button"
          className={option === value ? "active" : ""}
          disabled={disabled}
          onClick={() => onChange(option)}
        >
          {labels?.[option] ?? option}
        </button>
      ))}
    </div>
  );
}

function Toggle({
  checked = false,
  disabled = false,
  onChange,
}: {
  checked?: boolean;
  disabled?: boolean;
  onChange?: (checked: boolean) => void;
}) {
  return (
    <input
      className="toggle"
      type="checkbox"
      checked={checked}
      disabled={disabled}
      onChange={(event) => onChange?.(event.currentTarget.checked)}
    />
  );
}
