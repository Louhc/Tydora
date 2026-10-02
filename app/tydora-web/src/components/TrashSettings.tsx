/**
 * 设置 → 通用 里的「回收站」卡片。
 *
 * 职责：显示/调整回收站位置、展示占用与条目列表、恢复条目（视为新建文件）、
 * 彻底删除单条、清空回收站。数据一律走 services/recycleBin，组件只做展示与交互。
 */
import { useCallback, useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { open } from "@tauri-apps/plugin-dialog";
import { invoke } from "@tauri-apps/api/core";
import { ConfirmDialog } from "./ConfirmDialog";
import { formatBytes } from "../utils/formatBytes";
import {
  TRASH_MAX_BYTES,
  deleteTrashEntry,
  emptyTrash,
  getConfiguredTrashDir,
  getTrashDir,
  listTrashEntries,
  restoreTrashEntry,
  setConfiguredTrashDir,
  type TrashEntry,
} from "../services/recycleBin";

export function TrashSettings() {
  const { t } = useTranslation();
  const [trashDir, setTrashDir] = useState("");
  const [entries, setEntries] = useState<TrashEntry[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /** 最近一次操作的结果（恢复后的新路径等），在卡片里就地提示，不弹系统 alert */
  const [notice, setNotice] = useState<string | null>(null);
  const [emptyConfirmOpen, setEmptyConfirmOpen] = useState(false);

  const refresh = useCallback(async () => {
    try {
      setError(null);
      setTrashDir(await getTrashDir());
      setEntries(await listTrashEntries());
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const totalBytes = entries.reduce((sum, e) => sum + (Number.isFinite(e.size) ? e.size : 0), 0);
  const isDefaultLocation = getConfiguredTrashDir() === null;

  const handleChooseLocation = useCallback(async () => {
    const picked = await open({ directory: true, multiple: false });
    if (typeof picked !== "string" || !picked) return;
    setConfiguredTrashDir(picked);
    await refresh();
  }, [refresh]);

  const handleUseDefault = useCallback(async () => {
    setConfiguredTrashDir(null);
    await refresh();
  }, [refresh]);

  const handleOpenLocation = useCallback(async () => {
    try {
      await invoke("open_file_location", { filePath: trashDir });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [trashDir]);

  const handleRestore = useCallback(async (id: string) => {
    setBusy(true);
    setNotice(null);
    try {
      const restored = await restoreTrashEntry(id);
      await refresh();
      // 恢复结果（含重名加数字后的最终路径）就地告知，免得用户找不到文件
      setNotice(t("settings.trash.restoredTo", { path: restored }));
    } catch (err) {
      setError(t("settings.trash.restoreFailed", { error: err instanceof Error ? err.message : String(err) }));
    } finally {
      setBusy(false);
    }
  }, [refresh, t]);

  const handleDeleteOne = useCallback(async (id: string) => {
    setBusy(true);
    setNotice(null);
    try {
      await deleteTrashEntry(id);
      await refresh();
      setNotice(t("settings.trash.deleteOneDone"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [refresh, t]);

  const handleEmpty = useCallback(async () => {
    setEmptyConfirmOpen(false);
    setBusy(true);
    setNotice(null);
    try {
      await emptyTrash();
      await refresh();
      setNotice(t("settings.trash.emptyDone"));
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setBusy(false);
    }
  }, [refresh, t]);

  const formatTime = (ms: number) => new Date(ms).toLocaleString();

  return (
    <div className="canvas-settings-card">
      <div className="canvas-settings-row">
        <div className="canvas-settings-row-label">
          <span className="canvas-settings-row-title">{t("settings.trash.title")}</span>
          <span className="canvas-settings-row-desc">
            {t("settings.trash.desc", { limit: formatBytes(TRASH_MAX_BYTES) })}
          </span>
        </div>
      </div>

      <div className="canvas-settings-row">
        <div className="canvas-settings-row-label">
          <span className="canvas-settings-row-title">{t("settings.trash.location")}</span>
          <span className="canvas-settings-row-desc">
            {isDefaultLocation ? t("settings.trash.defaultLocation") : trashDir}
          </span>
        </div>
        <div className="canvas-settings-row-control">
          <button className="settings-button" onClick={handleChooseLocation} disabled={busy}>
            {t("settings.trash.select")}
          </button>
          <button className="settings-button" onClick={handleUseDefault} disabled={busy || isDefaultLocation}>
            {t("settings.trash.useDefault")}
          </button>
          <button className="settings-button" onClick={handleOpenLocation} disabled={!trashDir}>
            {t("settings.trash.open")}
          </button>
        </div>
      </div>

      <div className="canvas-settings-row">
        <div className="canvas-settings-row-label">
          <span className="canvas-settings-row-title">
            {t("settings.trash.usage", { count: entries.length, size: formatBytes(totalBytes) })}
          </span>
          {error && <span className="canvas-settings-row-desc trash-status-error">{error}</span>}
          {notice && <span className="canvas-settings-row-desc trash-status-ok">{notice}</span>}
        </div>
        <div className="canvas-settings-row-control">
          <button className="settings-button" onClick={() => void refresh()} disabled={busy}>
            {t("settings.trash.refresh")}
          </button>
          <button
            className="settings-button"
            onClick={() => setEmptyConfirmOpen(true)}
            disabled={busy || entries.length === 0}
          >
            {t("settings.trash.empty")}
          </button>
        </div>
      </div>

      {entries.length === 0 ? (
        <div className="canvas-settings-row">
          <div className="canvas-settings-row-label">
            <span className="canvas-settings-row-desc">{t("settings.trash.emptyList")}</span>
          </div>
        </div>
      ) : (
        <div className="trash-entry-list">
          {entries.map((entry) => (
            <div className="trash-entry" key={entry.id}>
              <div className="trash-entry-main">
                <span className="trash-entry-name" title={entry.originalPath}>
                  {entry.name}
                </span>
                <span className="trash-entry-meta">
                  {formatBytes(entry.size)} · {formatTime(entry.deletedAt)} · {entry.originalPath}
                </span>
              </div>
              <div className="trash-entry-actions">
                <button className="settings-button" onClick={() => void handleRestore(entry.id)} disabled={busy}>
                  {t("settings.trash.restore")}
                </button>
                <button className="settings-button" onClick={() => void handleDeleteOne(entry.id)} disabled={busy}>
                  {t("settings.trash.deleteOne")}
                </button>
              </div>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        isOpen={emptyConfirmOpen}
        title={t("settings.trash.emptyConfirmTitle")}
        message={t("settings.trash.emptyConfirmMessage", {
          count: entries.length,
          size: formatBytes(totalBytes),
        })}
        type="danger"
        onConfirm={() => void handleEmpty()}
        onCancel={() => setEmptyConfirmOpen(false)}
      />
    </div>
  );
}
