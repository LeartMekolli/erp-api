import { Test } from '@nestjs/testing';
import { PrismaPg } from '@prisma/adapter-pg';
import { ConfigModule } from '../src/config/config.module';
import { DatabaseModule } from '../src/database/database.module';
import { PrismaService } from '../src/database/prisma.service';
import { PrismaClient } from '../src/generated/prisma/client';

/**
 * ADR 0003: append-only tables are protected twice. The application role loses
 * UPDATE and DELETE, and a trigger refuses them for everyone else — including
 * the owner, which still holds every privilege.
 *
 * The fixture is set up as erp_owner, as a migration would: erp_app can neither
 * create tables nor attach triggers.
 */
describe('append-only tables', () => {
  let app: PrismaService;
  let owner: PrismaClient;

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [ConfigModule, DatabaseModule],
    }).compile();
    await moduleRef.init();
    app = moduleRef.get(PrismaService);

    // The application no longer reads the owner URL; this fixture plays the migration.
    const migrateUrl = process.env.DATABASE_MIGRATE_URL;
    owner = new PrismaClient({ adapter: new PrismaPg({ connectionString: migrateUrl }) });

    await owner.$executeRawUnsafe('DROP TABLE IF EXISTS append_only_fixture');
    await owner.$executeRawUnsafe(
      'CREATE TABLE append_only_fixture (id int PRIMARY KEY, note text NOT NULL)',
    );
    await owner.$executeRawUnsafe(`SELECT make_append_only('append_only_fixture')`);
  });

  afterAll(async () => {
    await owner.$executeRawUnsafe('DROP TABLE IF EXISTS append_only_fixture');
    await owner.$disconnect();
    await app.$disconnect();
  });

  it('lets the application insert', async () => {
    await expect(
      app.$executeRaw`INSERT INTO append_only_fixture (id, note) VALUES (1, 'first')`,
    ).resolves.toBe(1);
  });

  it('denies the application update and delete by privilege', async () => {
    await expect(
      app.$executeRaw`UPDATE append_only_fixture SET note = 'changed' WHERE id = 1`,
    ).rejects.toThrow(/permission denied/i);
    await expect(app.$executeRaw`DELETE FROM append_only_fixture WHERE id = 1`).rejects.toThrow(
      /permission denied/i,
    );
  });

  it('refuses update, delete and truncate even for the owner', async () => {
    await expect(
      owner.$executeRaw`UPDATE append_only_fixture SET note = 'changed' WHERE id = 1`,
    ).rejects.toThrow(/append-only/i);
    await expect(owner.$executeRaw`DELETE FROM append_only_fixture WHERE id = 1`).rejects.toThrow(
      /append-only/i,
    );
    await expect(owner.$executeRawUnsafe('TRUNCATE append_only_fixture')).rejects.toThrow(
      /append-only/i,
    );
  });

  it('leaves the row intact after the refused mutations', async () => {
    const rows = await app.$queryRaw<{ note: string }[]>`SELECT note FROM append_only_fixture`;

    expect(rows).toEqual([{ note: 'first' }]);
  });

  it('protects the workflow transition tables, even from the owner', async () => {
    for (const table of ['transition', 'transition_answer', 'transition_photo']) {
      await expect(owner.$executeRawUnsafe(`UPDATE ${table} SET id = id`)).rejects.toThrow(/append-only/i);
      await expect(owner.$executeRawUnsafe(`DELETE FROM ${table}`)).rejects.toThrow(/append-only/i);
      // Postgres refuses to truncate `transition` before the trigger runs: its answers and photos point at it.
      await expect(owner.$executeRawUnsafe(`TRUNCATE ${table}`)).rejects.toThrow(/append-only|referenced in a foreign key/i);
    }
  });

  it('can be applied twice without failing', async () => {
    await expect(
      owner.$executeRawUnsafe(`SELECT make_append_only('append_only_fixture')`),
    ).resolves.toBeDefined();
  });
});
