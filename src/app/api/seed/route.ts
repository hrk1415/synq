import { seedDatabase } from '@/lib/db';

export async function POST() {
  await seedDatabase();
  return Response.json({ message: 'Database seeded successfully' });
}
