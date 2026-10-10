export async function POST() {
  return Response.json(
    { error: 'Agent proxy simulation is no longer supported' },
    { status: 410 },
  );
}
