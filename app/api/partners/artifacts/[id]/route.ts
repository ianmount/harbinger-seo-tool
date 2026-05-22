import { NextResponse } from "next/server"
import { deleteArtifact, getArtifact } from "@/lib/partners"

export const dynamic = "force-dynamic"

function errorMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return "Unknown error"
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  try {
    const artifact = await getArtifact(id)
    if (!artifact) {
      return NextResponse.json({ error: "Artifact not found" }, { status: 404 })
    }
    return NextResponse.json({ artifact })
  } catch (error) {
    console.error(`[api/partners/artifacts/${id}] GET failed:`, error)
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 })
  }
}

export async function DELETE(
  _request: Request,
  { params }: { params: Promise<{ id: string }> },
) {
  const { id } = await params
  try {
    await deleteArtifact(id)
    return NextResponse.json({ ok: true })
  } catch (error) {
    console.error(`[api/partners/artifacts/${id}] DELETE failed:`, error)
    return NextResponse.json({ error: errorMessage(error) }, { status: 500 })
  }
}
