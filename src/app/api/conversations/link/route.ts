/** Retained as an explicit tombstone for clients using the retired legacy API. */
export async function POST() {
  return Response.json(
    { error: 'Legacy conversation linking is no longer supported' },
    { status: 410 },
  );
}
