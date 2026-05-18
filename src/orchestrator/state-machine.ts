import type { ServiceConfig } from "../config/service-config.js";
import type { NormalizedIssue } from "../domain.js";

export function labelsForRunning(issue: NormalizedIssue, config: ServiceConfig) {
  return {
    add: [config.tracker.labels.running],
    remove: [
      config.tracker.labels.ready,
      config.tracker.labels.review,
      config.tracker.labels.failed,
      config.tracker.labels.done
    ].filter((label) => issue.labels.includes(label.toLowerCase()))
  };
}

export function labelsForReview(config: ServiceConfig) {
  return {
    add: [config.tracker.labels.review],
    remove: [config.tracker.labels.running, config.tracker.labels.ready, config.tracker.labels.failed]
  };
}

export function labelsForFailed(config: ServiceConfig) {
  return {
    add: [config.tracker.labels.failed],
    remove: [config.tracker.labels.running, config.tracker.labels.ready, config.tracker.labels.review]
  };
}
