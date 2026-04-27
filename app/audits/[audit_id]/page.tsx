import { AuditDashboardClient } from "./AuditDashboardClient"

/**
 * Server entry — Next.js requires an awaited `params` access in v16. The
 * actual rehydration from sessionStorage and rendering happens in the
 * client component (`AuditDashboardClient`).
 */
export default async function AuditDashboardPage({
  params,
}: {
  params: Promise<{ audit_id: string }>
}) {
  const { audit_id } = await params
  return <AuditDashboardClient auditId={audit_id} />
}
