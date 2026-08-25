import { seedDatabase } from '@/lib/db';

export async function POST() {
  seedDatabase();
  return Response.json({ message: 'Database seeded successfully' });
}
