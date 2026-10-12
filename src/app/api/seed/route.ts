export async function POST() {
  return Response.json(
    { error: 'Database seeding through this endpoint is no longer supported' },
    { status: 410 },
  );
}
