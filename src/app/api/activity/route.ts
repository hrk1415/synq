export async function GET() {
  return Response.json(
    { error: 'Legacy activity API is no longer supported' },
    { status: 410 },
  );
}
