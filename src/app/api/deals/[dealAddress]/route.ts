const retired = () => Response.json(
  { error: 'Legacy Deal API is no longer supported' },
  { status: 410 },
);

export async function GET() {
  return retired();
}

export async function PATCH() {
  return retired();
}
