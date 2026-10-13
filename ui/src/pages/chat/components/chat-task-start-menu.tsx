import { createUniqueId } from "solid-js";
import { Icon } from "../../../components/solid/icon.tsx";
import { Menu } from "../../../components/solid/menu.tsx";
import { t } from "../../../lib/reactive/i18n.ts";
import type { TaskSuggestionStartMode } from "./chat-task-suggestions.ts";

export function ChatTaskStartMenu(props: {
  busy: boolean;
  canAccept: boolean;
  onSelect: (mode: TaskSuggestionStartMode) => void;
}) {
  const id = createUniqueId();
  return (
    <Menu
      id={`task-start-${id}`}
      placement="bottom-end"
      label={t("chat.taskSuggestions.startOptions")}
      disabled={props.busy || !props.canAccept}
      triggerClass="btn task-suggestion__start task-suggestion__start--options"
      triggerAttributes={{ title: props.canAccept ? "" : t("chat.taskSuggestions.adminRequired") }}
      trigger={<Icon name="chevronDown" />}
      items={[
        {
          id: "local",
          label: t("chat.taskSuggestions.startSession"),
          attributes: { value: "local" },
          disabled: props.busy || !props.canAccept,
        },
        {
          id: "worktree",
          label: t("chat.taskSuggestions.startWorktree"),
          attributes: { value: "worktree" },
          disabled: props.busy || !props.canAccept,
        },
        {
          id: "session",
          label: t("chat.taskSuggestions.startCurrentSession"),
          attributes: { value: "session" },
          disabled: props.busy || !props.canAccept,
        },
      ]}
      onSelect={(item) => {
        if (item.id === "local" || item.id === "worktree" || item.id === "session") {
          props.onSelect(item.id);
        }
      }}
    />
  );
}
