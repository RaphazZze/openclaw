# Advisor (plugin)

Experimental and off by default. During user-directed work, Advisor reviews a
fork of the conversation on the session's own model. When it finds avoidable
work, such as drifting beyond the request or repeated tool calls, it steers the
active run with one short correction. If the run cannot accept steering, the
correction becomes hidden context on the next turn and expires after 24 hours.

Enable it in **Settings → Agents & Tools → Labs → Advisor**. Its **Configure**
button opens the plugin's settings page. Or use config:

```json
{
  "plugins": {
    "entries": {
      "advisor": {
        "enabled": true,
        "config": { "everyToolCalls": 10, "everyMinutes": 20 }
      }
    }
  }
}
```

`everyToolCalls` counts tool calls as they start, including commands that are
still running in the background. `everyMinutes` counts accumulated agent run
time, checked as tools start and when a run ends. Either trigger
starts a review; `0` disables a trigger. Both counters restart after a review.
Heartbeat, cron, memory-flush, overflow, and side-question runs do not count.

Reviews keep the session's model and context; there is no separate model setting.
The fork cannot execute tools, persist conversation messages, or send replies.
The plugin needs conversation access and prompt injection permission through
`plugins.entries.advisor.hooks` (the normal trusted-plugin defaults). At most one
review runs per session. Resetting the session, disabling the plugin, or stopping
its service cancels pending reviews. Gateway info logs record review token usage
(input, cache reads, and output) and whether advice was steered or queued.

Docs: https://docs.openclaw.ai/concepts/experimental-features#advisor
