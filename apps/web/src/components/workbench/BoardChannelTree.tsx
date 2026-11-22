import { useMemo } from "react";
import { Clock, FolderTree, HelpCircle, Layers, Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { BoardTopicFilter } from "@/stores/board-store";
import type { BoardChannelSummary, BoardTopic } from "@/types";

export interface BoardChannelTreeProps {
  channels: BoardChannelSummary[];
  topics: BoardTopic[];
  openBoardQuestionCount: number;
  selectedChannel: string | null;
  topicFilter: BoardTopicFilter;
  boardPermissionDenied: boolean;
  inDrawer?: boolean;
  onSelectView: (channel: string | null, filter: BoardTopicFilter) => void;
  onOpenNewTopic: () => void;
}

interface ChannelGroup {
  groupName: string;
  items: BoardChannelSummary[];
}

export function BoardChannelTree({
  channels,
  topics,
  openBoardQuestionCount,
  selectedChannel,
  topicFilter,
  boardPermissionDenied,
  inDrawer = false,
  onSelectView,
  onOpenNewTopic
}: BoardChannelTreeProps) {
  const totalActiveCount = useMemo(
    () => topics.filter((t) => t.status !== "archived").length,
    [topics]
  );

  const groupedChannels = useMemo<ChannelGroup[]>(() => {
    const groups = new Map<string, BoardChannelSummary[]>();
    for (const ch of channels) {
      const slashIdx = ch.channel.indexOf("/");
      const groupName = slashIdx > 0 ? ch.channel.slice(0, slashIdx) : "根目录";
      const list = groups.get(groupName);
      if (list) {
        list.push(ch);
      } else {
        groups.set(groupName, [ch]);
      }
    }
    return Array.from(groups.entries())
      .sort(([a], [b]) => {
        if (a === "根目录") return 1;
        if (b === "根目录") return -1;
        return a.localeCompare(b);
      })
      .map(([groupName, items]) => ({
        groupName,
        items: [...items].sort((a, b) => a.channel.localeCompare(b.channel))
      }));
  }, [channels]);

  return (
    <aside
      aria-label="协同板频道与视图"
      data-testid="board-channel-tree"
      className="relative flex h-full flex-col bg-surface-elevated overflow-hidden"
    >
      <div className="flex min-h-11 md:min-h-0 md:h-10 shrink-0 items-center justify-between gap-2 border-b border-border px-3 py-1.5 md:py-0">
        <div className="flex min-w-0 items-center gap-1.5">
          <FolderTree className="h-3.5 w-3.5 shrink-0 text-muted-foreground" strokeWidth={1.75} aria-hidden="true" />
          <span className="truncate text-xs font-semibold tracking-tight text-foreground">
            协同频道
          </span>
        </div>
        {!boardPermissionDenied ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={onOpenNewTopic}
            data-testid="board-new-topic-btn"
            className="min-h-11 md:min-h-0 md:h-7 px-2.5 md:px-2 text-xs md:text-[11px]"
          >
            <Plus className="h-3.5 w-3.5" strokeWidth={1.75} aria-hidden="true" />
            新建主题
          </Button>
        ) : null}
      </div>

      <div className="min-h-0 flex-1 overflow-y-auto px-2 py-2 space-y-3">
        {/* Quick Views */}
        <div className="space-y-1">
          <button
            type="button"
            data-testid="board-filter-active"
            onClick={() => onSelectView(null, "active")}
            className={cn(
              "flex w-full min-h-11 md:min-h-8 items-center justify-between gap-2 rounded-[6px] px-2.5 text-xs transition-colors cursor-pointer",
              selectedChannel === null && topicFilter === "active"
                ? "bg-accent text-accent-foreground font-medium"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              <Layers className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
              <span className="truncate">全部活跃</span>
            </span>
            <span className="shrink-0 font-mono text-[11px] tabular-nums">
              {totalActiveCount}
            </span>
          </button>

          <button
            type="button"
            data-testid="board-filter-open-questions"
            onClick={() => onSelectView(null, "open_questions")}
            className={cn(
              "flex w-full min-h-11 md:min-h-8 items-center justify-between gap-2 rounded-[6px] px-2.5 text-xs transition-colors cursor-pointer",
              selectedChannel === null && topicFilter === "open_questions"
                ? "bg-accent text-accent-foreground font-medium"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              <HelpCircle
                className={cn(
                  "h-3.5 w-3.5 shrink-0",
                  openBoardQuestionCount > 0 ? "text-[var(--status-approval)]" : "text-muted-foreground"
                )}
                strokeWidth={1.75}
                aria-hidden="true"
              />
              <span className="truncate">待我确认</span>
            </span>
            <span
              className={cn(
                "shrink-0 rounded px-1.5 py-0.5 font-mono text-[11px] leading-none tabular-nums",
                openBoardQuestionCount > 0
                  ? "bg-[var(--status-approval)] text-black font-semibold"
                  : "text-muted-foreground"
              )}
            >
              {openBoardQuestionCount}
            </span>
          </button>

          <button
            type="button"
            data-testid="board-filter-recent"
            onClick={() => onSelectView(null, "recent")}
            className={cn(
              "flex w-full min-h-11 md:min-h-8 items-center justify-between gap-2 rounded-[6px] px-2.5 text-xs transition-colors cursor-pointer",
              selectedChannel === null && topicFilter === "recent"
                ? "bg-accent text-accent-foreground font-medium"
                : "text-muted-foreground hover:bg-accent/50 hover:text-foreground"
            )}
          >
            <span className="flex min-w-0 items-center gap-2">
              <Clock className="h-3.5 w-3.5 shrink-0" strokeWidth={1.75} aria-hidden="true" />
              <span className="truncate">近期动态</span>
            </span>
            <span className="shrink-0 font-mono text-[11px] tabular-nums">
              {totalActiveCount}
            </span>
          </button>
        </div>

        {/* Channel Tree */}
        <div className="space-y-2 border-t border-border pt-2.5">
          <div className="px-2 text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
            频道树 Channels
          </div>

          {boardPermissionDenied ? (
            <div
              data-testid="board-permission-denied-banner"
              className="rounded-[6px] border border-border bg-background/60 p-2.5 text-xs leading-relaxed text-muted-foreground text-pretty"
            >
              当前凭证尚未分配协同板频道前缀权限（`allowed_board_prefixes`）。请联系管理员在凭证管理中授权后再访问。
            </div>
          ) : groupedChannels.length === 0 ? (
            <div className="rounded-[6px] border border-dashed border-border px-2.5 py-4 text-center text-[11px] text-muted-foreground text-pretty">
              暂无频道记录，点击右上角「新建主题」发起跨机协同。
            </div>
          ) : (
            <div className={cn("space-y-2.5", inDrawer && "pb-4")}>
              {groupedChannels.map((group) => (
                <div key={group.groupName} className="space-y-0.5">
                  <div className="px-2 py-0.5 font-mono text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">
                    {group.groupName}/
                  </div>
                  {group.items.map((ch) => {
                    const isSelected = selectedChannel === ch.channel;
                    const leafLabel =
                      group.groupName !== "根目录" && ch.channel.startsWith(`${group.groupName}/`)
                        ? ch.channel.slice(group.groupName.length + 1)
                        : ch.channel;
                    return (
                      <button
                        key={ch.channel}
                        type="button"
                        data-testid={`board-channel-item-${ch.channel}`}
                        onClick={() => onSelectView(ch.channel, "active")}
                        className={cn(
                          "flex w-full min-h-11 md:min-h-8 items-center justify-between gap-2 rounded-[6px] pl-4 pr-2.5 text-left text-xs transition-colors cursor-pointer",
                          isSelected
                            ? "bg-accent text-accent-foreground font-medium"
                            : "text-foreground/85 hover:bg-accent/50 hover:text-foreground"
                        )}
                      >
                        <span className="truncate font-mono">{leafLabel}</span>
                        <span className="flex shrink-0 items-center gap-1.5 font-mono text-[10px] tabular-nums">
                          {ch.open_question_count > 0 ? (
                            <span className="rounded bg-[var(--status-approval)]/15 px-1 py-0.5 text-[var(--status-approval)] font-medium">
                              ?{ch.open_question_count}
                            </span>
                          ) : null}
                          <span className="text-muted-foreground">{ch.active_topic_count}</span>
                        </span>
                      </button>
                    );
                  })}
                </div>
              ))}
            </div>
          )}
        </div>
      </div>
    </aside>
  );
}
