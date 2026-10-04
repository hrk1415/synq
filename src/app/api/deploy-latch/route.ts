export async function POST() {
  return Response.json(
    { error: 'Latch deployment through Synq is no longer supported' },
    { status: 410 },
  );
}
