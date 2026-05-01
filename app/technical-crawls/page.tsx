import { redirect } from "next/navigation"

/**
 * Legacy /technical-crawls path. Replaced by /scheduled-tasks, which folds
 * crawls + audits into a single pipeline. Redirect kept around so any
 * bookmarks, links from old emails, or external references still land
 * somewhere useful.
 */
export default function TechnicalCrawlsRedirect() {
  redirect("/scheduled-tasks")
}
