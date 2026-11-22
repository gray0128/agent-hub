import { useMemo } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { ExternalLink, GitBranch, Pin, PinOff, Terminal } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue
} from "@/components/ui/select";
import { formatShortTime } from "@/lib/utils";
import type { BoardMessage, BoardTopic, BoardTopicStatus } from "@/types";
import { CopyButton } from "./CopyButton";
import { MARKDOWN_COMPONENTS } from "./markdown-components";
import { BoardTopicStatusBadge } from "./StatusBadge";

export interface BoardTopicInspectorProps {
  topic: BoardTopic | null;
  messages: BoardMessage[];
  updatingTopic: boolean;
  onUpdateStatus: (topicId: string, status: BoardTopicStatus) => void;
  onTogglePin: (topic: BoardTopic) => void;
}

const TOPIC_STATUS_OPTIONS: Array<{ value: BoardTopicStatus; label: string }> = [
  { value: "todo", label: "待办 (todo)" },
  { value: "in_progress", label: "进行中 (in_progress)" },
  { value: "blocked", label: "阻塞中 (blocked)" },
  { value: "done", label: "已完成 (done)" },
  { value: "archived", label: "已归档 (archived)" }
];

function strField(data: Record<string, unknown>, key: string): string {
  const val = data[key];
  return typeof val === "string" ? val.trim() : "";
}

function filesField(data: Record<string, unknown>): string[] {
  const raw = data.files;
  if (!Array.isArray(raw)) return [];
  return raw.filter((item): item is string => typeof item === "string" && item.trim().length > 0);
}

export function BoardTopicInspector({
  topic,
  messages,
  updatingTopic,
  onUpdateStatus,
  onTogglePin
}: BoardTopicInspectorProps) {
  const participants = useMemo(() => {
    const nodes = new Set<string>();
    const profiles = new Set<string>();
    if (topic?.latest_handoff?.source_node) {
      nodes.add(topic.latest_handoff.source_node);
    }
    if (topic?.latest_handoff?.actor_profile) {
      profiles.add(topic.latest_handoff.actor_profile);
    }
    for (const m of messages) {
      if (m.source_node) nodes.add(m.source_node);
      if (m.actor_profile) profiles.add(m.actor_profile);
    }
    return {
      nodes: Array.from(nodes).sort(),
      profiles: Array.from(profiles).sort()
    };
  }, [messages, topic?.latest_handoff]);

  const handoff = topic?.latest_handoff ?? null;
  const handoffData = handoff?.data ?? {};
  const repo = strField(handoffData, "repo");
  const branch = strField(handoffData, "branch");
  const commitSha = strField(handoffData, "commit_sha");
  const prUrl = strField(handoffData, "pr_url");
  const nextAction = strField(handoffData, "next_action");
  const handoffFiles = filesField(handoffData);

  const readCliCmd = topic
    ? topic.external_ref
      ? `ahub board read ${topic.channel} --ref ${topic.external_ref} --json`
      : `ahub board read ${topic.channel} --topic ${topic.id} --json`
    : "";

  return (
    <aside
      aria-label="主题上下文检视器"
      data-testid="board-topic-inspector"
      className="relative flex h-full flex-col bg-surface-elevated overflow-hidden"
    >
      <div className="flex min-h-11 md:min-h-0 md:h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5 md:py-0">
        <span className="truncate text-xs font-semibold tracking-tight text-foreground">
          主题上下文
        </span>
        {topic ? (
          <span className="shrink-0 font-mono text-[10px] text-muted-foreground tabular-nums">
            cursor #{topic.last_event_cursor}
          </span>
        ) : null}
      </div>

      {!topic ? (
        <div className="flex flex-1 items-center justify-center p-4 text-center text-xs text-muted-foreground">
          选择左侧协同主题查看状态与最新交接快照
        </div>
      ) : (
        <div className="min-h-0 flex-1 overflow-y-auto divide-y divide-border text-xs">
          {/* Section 1: Status, Pin & Anchor */}
          <div className="space-y-3 p-3">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-medium text-muted-foreground">主题状态</span>
              <div className="flex items-center gap-1.5">
                <BoardTopicStatusBadge status={topic.status} />
                <Button
                  type="button"
                  size="sm"
                  variant={topic.pinned ? "secondary" : "outline"}
                  disabled={updatingTopic}
                  onClick={() => onTogglePin(topic)}
                  data-testid="board-topic-pin-btn"
                  aria-label={topic.pinned ? "取消置顶主题" : "置顶主题"}
                  className="min-h-11 md:min-h-0 md:h-7 px-2.5 md:px-2 text-xs md:text-[11px]"
                >
                  {topic.pinned ? (
                    <>
                      <PinOff className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                      已置顶
                    </>
                  ) : (
                    <>
                      <Pin className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                      置顶
                    </>
                  )}
                </Button>
              </div>
            </div>

            <Select
              value={topic.status}
              disabled={updatingTopic}
              onValueChange={(v) => onUpdateStatus(topic.id, v as BoardTopicStatus)}
            >
              <SelectTrigger
                aria-label="切换主题状态"
                data-testid="board-topic-status-select"
              >
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                {TOPIC_STATUS_OPTIONS.map((opt) => (
                  <SelectItem key={opt.value} value={opt.value}>
                    {opt.label}
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>

            <div className="space-y-1.5 pt-1">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted-foreground">频道路径</span>
                <span className="truncate font-mono text-[11px] text-foreground">
                  {topic.channel}
                </span>
              </div>

              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted-foreground">主题 ID</span>
                <div className="flex min-w-0 items-center gap-1">
                  <span className="truncate font-mono text-[11px] text-muted-foreground">
                    {topic.id}
                  </span>
                  <CopyButton text={topic.id} ariaLabel="复制主题 ID" />
                </div>
              </div>

              {topic.external_ref ? (
                <div className="flex items-center justify-between gap-2">
                  <span className="shrink-0 text-[11px] text-muted-foreground">external_ref</span>
                  <div className="flex min-w-0 items-center gap-1">
                    <Badge
                      variant="outline"
                      data-testid="board-topic-external-ref"
                      className="max-w-[160px] truncate font-mono text-[10px]"
                    >
                      {topic.external_ref}
                    </Badge>
                    <CopyButton text={topic.external_ref} ariaLabel="复制 external_ref" />
                  </div>
                </div>
              ) : null}

              <div className="flex items-center justify-between gap-2">
                <span className="text-[11px] text-muted-foreground">最近更新</span>
                <span className="font-mono text-[11px] text-muted-foreground tabular-nums">
                  {formatShortTime(topic.updated_at)}
                </span>
              </div>
            </div>
          </div>

          {/* Section 2: Participating Nodes & Profiles */}
          <div className="space-y-2 p-3">
            <div className="text-[11px] font-medium text-muted-foreground">
              参与节点与角色署名
            </div>
            {participants.nodes.length === 0 && participants.profiles.length === 0 ? (
              <div className="text-[11px] text-muted-foreground">暂无节点或角色记录</div>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {participants.nodes.map((node) => (
                  <Badge key={`node:${node}`} variant="outline" className="font-mono text-[10px]">
                    @{node}
                  </Badge>
                ))}
                {participants.profiles.map((profile) => (
                  <Badge key={`prof:${profile}`} variant="secondary" className="font-mono text-[10px]">
                    {profile}
                  </Badge>
                ))}
              </div>
            )}
          </div>

          {/* Section 3: Latest Handoff Snapshot */}
          <div className="space-y-2.5 p-3" data-testid="board-latest-handoff">
            <div className="flex items-center justify-between gap-2">
              <span className="text-[11px] font-semibold text-foreground">最新交接快照</span>
              {handoff ? (
                <span className="font-mono text-[10px] text-muted-foreground tabular-nums">
                  {formatShortTime(handoff.created_at)}
                </span>
              ) : null}
            </div>

            {!handoff ? (
              <div className="rounded-[6px] border border-dashed border-border bg-background/40 px-2.5 py-3 text-[11px] text-muted-foreground">
                暂无 `handoff` 交接消息。使用下方 Composer 发送 `handoff` 或运行 `ahub board post --kind handoff` 写入交接上下文。
              </div>
            ) : (
              <div className="space-y-2 rounded-[6px] border border-border bg-background/60 p-2.5">
                <div className="flex flex-wrap items-center justify-between gap-1.5 border-b border-border pb-1.5 font-mono text-[11px]">
                  <span className="font-medium text-foreground">
                    {handoff.actor_profile || "agent"}
                    {handoff.source_node ? `@${handoff.source_node}` : ""}
                  </span>
                  <span className="text-[10px] text-muted-foreground tabular-nums">
                    {handoff.id}
                  </span>
                </div>

                {(repo || branch || commitSha || prUrl) ? (
                  <div className="space-y-1 font-mono text-[11px]">
                    {repo ? (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground">repo</span>
                        <span className="truncate text-foreground">{repo}</span>
                      </div>
                    ) : null}
                    {branch ? (
                      <div className="flex items-center justify-between gap-2">
                        <span className="flex items-center gap-1 text-muted-foreground">
                          <GitBranch className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                          branch
                        </span>
                        <span className="truncate text-foreground">{branch}</span>
                      </div>
                    ) : null}
                    {commitSha ? (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground">commit</span>
                        <span className="truncate text-foreground tabular-nums">
                          {commitSha.slice(0, 12)}
                        </span>
                      </div>
                    ) : null}
                    {prUrl && /^https?:\/\//i.test(prUrl) ? (
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-muted-foreground">PR</span>
                        <a
                          href={prUrl}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 truncate text-[var(--status-running)] hover:underline"
                        >
                          <span className="truncate">{prUrl}</span>
                          <ExternalLink className="h-3 w-3 shrink-0" strokeWidth={1.75} aria-hidden="true" />
                        </a>
                      </div>
                    ) : null}
                  </div>
                ) : null}

                {nextAction ? (
                  <div className="rounded-[4px] border border-[var(--status-running)]/30 bg-[var(--status-running)]/10 px-2 py-1.5 text-[11px] text-foreground">
                    <span className="font-mono text-[10px] text-[var(--status-running)] uppercase">
                      next_action:
                    </span>{" "}
                    <span>{nextAction}</span>
                  </div>
                ) : null}

                {handoffFiles.length > 0 ? (
                  <div className="space-y-1">
                    <div className="text-[10px] font-mono text-muted-foreground">变更文件</div>
                    <div className="max-h-24 overflow-y-auto space-y-0.5 font-mono text-[10px] text-foreground/85">
                      {handoffFiles.slice(0, 12).map((f) => (
                        <div key={f} className="truncate">
                          {f}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {handoff.text_md ? (
                  <div className="ahub-markdown border-t border-border pt-2">
                    <ReactMarkdown remarkPlugins={[remarkGfm]} components={MARKDOWN_COMPONENTS}>
                      {handoff.text_md}
                    </ReactMarkdown>
                  </div>
                ) : null}
              </div>
            )}

            <div className="space-y-1.5 rounded-[6px] border border-border bg-background/40 p-2">
              <div className="flex items-center justify-between gap-2">
                <span className="flex items-center gap-1 font-mono text-[10px] text-muted-foreground">
                  <Terminal className="h-3 w-3" strokeWidth={1.75} aria-hidden="true" />
                  同步上下文命令
                </span>
                <CopyButton
                  text={readCliCmd}
                  label="复制命令"
                  copiedLabel="已复制"
                  variant="outline"
                  testId="board-copy-read-cmd-btn"
                />
              </div>
              <pre className="overflow-x-auto font-mono text-[10px] leading-relaxed text-foreground/90">
                {readCliCmd}
              </pre>
            </div>
          </div>
        </div>
      )}
    </aside>
  );
}
