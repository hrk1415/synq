const retired = () => Response.json(
  { error: 'Legacy escrow API is no longer supported' },
  { status: 410 },
);

export async function GET() {
  return retired();
}

export async function POST() {
  return retired();
}
