/**
 * Development seed.
 *
 * Builds a tenant with enough data to exercise every read path in the API:
 * categories, packages, services, published working hours, an approved booking
 * (which creates the project and timeline), a published album with photos, an
 * invoice, a payment, a conversation and a testimonial.
 *
 * Run with `npm run seed`, or `npm run seed:reset` to delete tenant-scoped data
 * first. Photos are synthesised locally with sharp, so no network access and no
 * binary fixtures in git. Set `SEED_PHOTOS_PER_PROJECT=0` for a fast,
 * fixture-only seed.
 */
import sharp from 'sharp';
import { faker } from '@faker-js/faker';
import type { Types } from 'mongoose';
import { env } from '../config/env.js';
import { connectDatabase, disconnectDatabase } from '../config/db.js';
import { hashPassword } from '../services/auth.service.js';
import { DEFAULT_CATEGORIES } from '../config/categories.js';
import type { PhotoCategory, StorageKey, UserRole } from '../config/constants.js';
import { processImage, safeFilename } from '../services/image/pipeline.js';
import { getStorage } from '../services/storage/index.js';
import { slugify, uniqueSlug } from '../utils/slug.js';
import { refreshAlbumCounts, refreshPhotoCounts, refreshProjectCounts } from '../services/counts.js';
import { applySuccessfulPayment } from '../services/payments/payment.service.js';
import { computeDeposit, toMinor, type DepositType } from '../utils/money.js';
import { createLogger } from '../utils/logger.js';
import {
  AlbumModel,
  AvailabilityBlockModel,
  AvailabilityRuleModel,
  BookingModel,
  CategoryModel,
  ClientProfileModel,
  ConversationModel,
  FavoriteModel,
  GalleryShareModel,
  InvoiceModel,
  MessageModel,
  NotificationModel,
  PackageModel,
  PaymentModel,
  PhotoCommentModel,
  PhotoModel,
  PhotoSelectionModel,
  PhotographerProfileModel,
  PortfolioItemModel,
  ProjectModel,
  RefreshTokenModel,
  ServiceModel,
  TestimonialModel,
  TimelineEventModel,
  VerificationTokenModel,
  UserModel,
} from '../models/index.js';

const log = createLogger('seed');

const RESET = process.argv.includes('--reset');

/** The subset of a lean Package document the seed actually reads. */
interface FlattenedPackage {
  _id: Types.ObjectId;
  name: string;
  price: number;
  priceMinor: number;
  depositType: DepositType;
  depositValue: number;
  durationHours: number;
  categoryKeys?: string[];
}

/* Deterministic by default: `SEED_RANDOM_SEED` keeps reseeds reproducible. */
faker.seed(env.SEED_RANDOM_SEED);

const argValue = (flag: string): string | undefined => {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
};

/* The seeded accounts share documented, fixed passwords, so running this against
 * a real deployment would hand out known credentials. Refuse unless the operator
 * explicitly acknowledges it. */
if (env.NODE_ENV === 'production' && !process.argv.includes('--force')) {
  console.error(
    'Refusing to seed: NODE_ENV=production seeds known demo accounts.\n' +
      'Set SEED_* credentials to unique values and re-run with --force if this is intended.',
  );
  process.exit(1);
}

const SEED = {
  photographerEmail: (argValue('--photographer-email') ?? env.SEED_PHOTOGRAPHER_EMAIL).toLowerCase(),
  clientEmail: (argValue('--client-email') ?? env.SEED_CLIENT_EMAIL).toLowerCase(),
  adminEmail: (argValue('--admin-email') ?? env.SEED_ADMIN_EMAIL).toLowerCase(),
  photosPerProject: Number(argValue('--photos') ?? env.SEED_PHOTOS_PER_PROJECT),
};

/** Synthetic stand-in for a real photograph: deterministic gradient + noise. */
async function synthPhoto(seed: number): Promise<Buffer> {
  const hue = seed % 360;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="1600" height="1067">
    <defs>
      <linearGradient id="g" x1="0" y1="0" x2="1" y2="1">
        <stop offset="0%" stop-color="hsl(${hue},58%,62%)"/>
        <stop offset="55%" stop-color="hsl(${(hue + 40) % 360},52%,44%)"/>
        <stop offset="100%" stop-color="hsl(${(hue + 90) % 360},46%,26%)"/>
      </linearGradient>
    </defs>
    <rect width="1600" height="1067" fill="url(#g)"/>
    <circle cx="${300 + (seed * 37) % 1000}" cy="${200 + (seed * 53) % 600}" r="${70 + (seed % 9) * 22}" fill="rgba(255,255,255,0.16)"/>
    <text x="60" y="990" font-family="sans-serif" font-size="46" fill="rgba(255,255,255,0.55)">LensFlow ${seed}</text>
  </svg>`;

  return sharp(Buffer.from(svg)).jpeg({ quality: 92 }).toBuffer();
}

async function upsertCategory(): Promise<void> {
  for (const [index, category] of DEFAULT_CATEGORIES.entries()) {
    await CategoryModel.updateOne(
      { key: category.key },
      { $set: { ...category, sortOrder: category.sortOrder || index, active: true } },
      { upsert: true },
    );
  }
  log.info(`categories upserted`, { count: DEFAULT_CATEGORIES.length });
}

async function upsertUser(input: {
  email: string;
  password: string;
  name: string;
  role: 'photographer' | 'client' | 'superadmin';
  phone?: string;
}): Promise<Types.ObjectId> {
  const password = await hashPassword(input.password);

  /* The password is part of `$set`, not `$setOnInsert`: a seeded account whose
   * password was changed between runs must end up matching the credentials this
   * run prints, otherwise the output is a lie. */
  const user = await UserModel.findOneAndUpdate(
    { email: input.email },
    {
      $set: {
        name: input.name,
        role: input.role,
        phone: input.phone ?? null,
        status: 'active',
        emailVerified: true,
        password,
      },
    },
    { new: true, upsert: true },
  );

  return user._id;
}

async function ensurePhotographerProfile(userId: Types.ObjectId, businessName: string): Promise<void> {
  const slug = await uniqueSlug(slugify(businessName) || 'photographer', async (candidate) =>
    Boolean(await PhotographerProfileModel.findOne({ slug: candidate }).select('_id').lean()),
  );

  await PhotographerProfileModel.updateOne(
    { userId },
    {
      $set: {
        businessName,
        slug,
        tagline: 'Wedding, portrait and event photography in Kathmandu.',
        bio: 'Seeded profile used for local development. Replaces the onboarding wizard.',
        location: 'Kathmandu, Nepal',
        address: { country: 'Nepal', city: 'Kathmandu' },
        specialties: ['wedding', 'portrait', 'event'],
        yearsExperience: 9,
        startingPrice: 45000,
        published: true,
        featured: true,
        instagram: 'https://instagram.com/lensflow.demo',
      },
      $setOnInsert: { userId },
    },
    { upsert: true },
  );
}

async function ensureClientProfile(userId: Types.ObjectId, photographerId: Types.ObjectId): Promise<void> {
  await ClientProfileModel.updateOne(
    { userId },
    { $set: { photographerIds: [photographerId], city: 'Kathmandu', address: 'Kathmandu, Nepal' } },
    { upsert: true },
  );
}

async function ensurePackages(photographerId: Types.ObjectId): Promise<void> {
  const catalogue = [
    { name: 'Wedding Signature', price: 185000, hours: 8, deposit: { type: 'percent' as const, value: 30 }, categoryKeys: ['wedding'], featured: true },
    { name: 'Pre-wedding Session', price: 42000, hours: 4, deposit: { type: 'percent' as const, value: 50 }, categoryKeys: ['pre_wedding'], featured: true },
    { name: 'Portrait Session', price: 18000, hours: 2, deposit: { type: 'fixed' as const, value: 5000 }, categoryKeys: ['portrait'], featured: false },
    { name: 'Corporate & Events', price: 95000, hours: 6, deposit: { type: 'full' as const, value: 0 }, categoryKeys: ['corporate', 'event'], featured: false },
    { name: 'Product Catalogue', price: 28000, hours: 3, deposit: { type: 'none' as const, value: 0 }, categoryKeys: ['product'], featured: false },
  ];

  for (const [index, item] of catalogue.entries()) {
    /* The slug is derived from the name and used as the upsert key directly.
     * Resolving it through `uniqueSlug` first would be self-defeating: the
     * existing seeded row already owns the slug, so every run would pick a
     * fresh `-2`, `-3`, ... suffix and duplicate the whole catalogue. */
    const slug = slugify(item.name);

    const priceMinor = toMinor(item.price);
    const depositMinor = computeDeposit(priceMinor, item.deposit.type, item.deposit.value);

    await PackageModel.updateOne(
      { photographerId, slug },
      {
        $set: {
          name: item.name,
          description: `${item.name} - seeded package covering ${item.hours} hours of coverage.`,
          price: item.price,
          priceMinor,
          currency: 'NPR',
          depositType: item.deposit.type,
          depositValue: item.deposit.value,
          depositMinor,
          durationHours: item.hours,
          categoryKeys: item.categoryKeys,
          editedPhotoCount: item.hours * 25,
          turnaroundDays: 14 + index * 3,
          includedServices: ['Pre-shoot consultation', 'Online gallery', 'Print release'],
          deliverables: ['High-resolution gallery', 'Web-optimised gallery', 'Print release PDF'],
          featured: item.featured,
          active: true,
          sortOrder: index,
          includesHighlightAlbum: index === 0,
        },
        $setOnInsert: { photographerId },
      },
      { upsert: true },
    );
  }

  log.info('packages upserted', { count: catalogue.length });
}

async function ensureServices(photographerId: Types.ObjectId): Promise<void> {
  const services = [
    { title: 'Wedding day coverage', categoryKey: 'wedding', hours: 10, price: 220000 },
    { title: 'Engagement shoot', categoryKey: 'pre_wedding', hours: 3, price: 38000 },
    { title: 'Studio portrait', categoryKey: 'portrait', hours: 2, price: 16000 },
    { title: 'Live event coverage', categoryKey: 'event', hours: 6, price: 88000 },
  ];

  for (const [index, service] of services.entries()) {
    /* Keyed by the derived slug so reruns update in place. See ensurePackages. */
    const slug = slugify(service.title);

    await ServiceModel.updateOne(
      { photographerId, slug },
      {
        $set: {
          title: service.title,
          description: `${service.title} offered as a standalone service.`,
          categoryKey: service.categoryKey,
          durationHours: service.hours,
          basePrice: service.price,
          deliverables: ['Online gallery'],
          active: true,
          sortOrder: index,
        },
        $setOnInsert: { photographerId },
      },
      { upsert: true },
    );
  }
}

/**
 * A new photographer has no availability rows at all, which makes every slot
 * read as `outside_working_hours`. The seed must publish hours before any
 * booking can succeed.
 */
async function ensureWorkingHours(photographerId: Types.ObjectId): Promise<void> {
  const windows = [
    { start: '09:00', end: '18:00' },
    { start: '18:00', end: '21:00' },
  ];

  for (let dayOfWeek = 0; dayOfWeek <= 6; dayOfWeek += 1) {
    await AvailabilityRuleModel.updateOne(
      { photographerId, dayOfWeek },
      { $set: { windows, active: true }, $setOnInsert: { photographerId, dayOfWeek } },
      { upsert: true },
    );
  }
  log.info('working hours published', { days: 7 });
}

function futureWeekday(daysAhead: number): Date {
  const date = new Date();
  date.setDate(date.getDate() + daysAhead);
  while (date.getDay() === 0) date.setDate(date.getDate() + 1);
  date.setHours(0, 0, 0, 0);
  return date;
}

/**
 * Creates an approved booking directly, then backfills the project, timeline,
 * album, photos, invoice, payment and conversation that the live approval route
 * would normally produce. Going through HTTP here would need the API running,
 * and a seed script has to work against a bare database.
 */
async function seedEngagement(input: {
  photographerId: Types.ObjectId;
  clientId: Types.ObjectId;
  pkg: FlattenedPackage;
  daysAhead: number;
  photos: number;
  index: number;
}): Promise<void> {
  const { photographerId, clientId, pkg } = input;

  const eventDate = futureWeekday(input.daysAhead);
  const totalMinor = pkg.priceMinor;
  const depositType = pkg.depositType;
  const depositValue = pkg.depositValue;
  const depositMinor = computeDeposit(totalMinor, depositType, depositValue);

  const booking = await BookingModel.create({
    reference: `LF-BK-SEED${String(input.index + 1).padStart(3, '0')}`,
    photographerId,
    clientId,
    packageId: pkg._id,
    eventType: ['Wedding', 'Pre-wedding', 'Portrait', 'Corporate', 'Product'][input.index % 5] ?? 'Wedding',
    eventDate,
    startTime: '10:00',
    endTime: '16:00',
    durationHours: Number(pkg.durationHours ?? 4),
    location: ['Pokhara Lakeside, Pokhara', 'Basantapur Durbar, Kathmandu', 'Tribhuvan Studio, Kathmandu'][input.index % 3] ?? 'Kathmandu',
    guestCount: 80 + input.index * 20,
    priceSnapshot: {
      packageName: pkg.name,
      total: pkg.price,
      totalMinor,
      currency: 'NPR',
      depositType,
      depositValue,
      depositMinor,
    },
    status: 'approved',
    reviewedAt: new Date(),
    reviewedBy: photographerId,
  });

  /* Project slugs are globally unique, so this one does need uniquifying.
   * The booking reference is the natural seed: it is unique per engagement and
   * makes the public gallery URL recognisable. */
  const projectSlug = await uniqueSlug(slugify(`${booking.eventType}-${booking.reference}`), async (candidate) =>
    Boolean(await ProjectModel.findOne({ slug: candidate }).select('_id').lean()),
  );

  const project = await ProjectModel.create({
    photographerId,
    clientId,
    bookingId: booking._id,
    title: `${booking.eventType} - ${booking.reference}`,
    slug: projectSlug,
    description: 'Seeded project used for local development.',
    eventDate,
    eventType: booking.eventType,
    location: booking.location,
    status: 'planning',
    timelineStage: 'booking_confirmed',
    totalMinor,
    currency: 'NPR',
  });

  await TimelineEventModel.create({
    projectId: project._id,
    photographerId,
    clientId,
    stage: 'booking_requested',
    title: 'Booking requested',
    description: 'The client sent a booking request.',
    automatic: true,
    trigger: 'BOOKING_REQUESTED',
    actorId: clientId,
    occurredAt: new Date(eventDate.getTime() - 20 * 86_400_000),
  });

  await TimelineEventModel.create({
    projectId: project._id,
    photographerId,
    clientId,
    stage: 'booking_confirmed',
    title: 'Booking confirmed',
    description: 'The photographer approved the booking.',
    automatic: true,
    trigger: 'BOOKING_APPROVED',
    actorId: photographerId,
    occurredAt: new Date(eventDate.getTime() - 19 * 86_400_000),
  });

  const album = await AlbumModel.create({
    projectId: project._id,
    photographerId,
    clientId,
    name: `${booking.eventType} highlights`,
    description: 'Seeded album.',
    selectionLimit: 30,
    status: 'selection_open',
    published: true,
    publishedAt: new Date(),
    sortOrder: 0,
    selectionOpenAt: new Date(),
    selectionDueAt: new Date(eventDate.getTime() + 21 * 86_400_000),
  });

  const storage = getStorage();
  /* Photo `category` is the sub-collection tag, not the package category. */
  const photoCategories: PhotoCategory[] = [
    'candid',
    'portraits',
    'details',
    'reception',
    'family',
    'pre_wedding',
    'highlights',
    'other',
  ];

  for (let n = 0; n < input.photos; n += 1) {
    const buffer = await synthPhoto(input.index * 1000 + n);
    const baseName = safeFilename(`seed-${input.index + 1}-${String(n + 1).padStart(3, '0')}`);
    const { image, buffers } = await processImage(buffer, baseName, 'seed');

    /* The pipeline returns storage keys as flat paths; the provider splits them
     * into a bucket plus an in-bucket key.
     *
     * Only the three variants the upload route persists are written. The
     * pipeline also renders a 48px `preview`, but no Photo field records its key
     * and nothing serves it, so storing it here would leak an object per photo
     * that `--reset` can never clean up. Mirrors routes/photo.routes.ts. */
    const variant = (key: string): { bucket: StorageKey; key: string } => {
      const slash = key.indexOf('/');
      return {
        bucket: (slash === -1 ? key : key.slice(0, slash)) as StorageKey,
        key: slash === -1 ? '' : key.slice(slash + 1),
      };
    };

    await Promise.all([
      storage.put(buffers.original, { ...variant(image.originalKey), contentType: 'image/jpeg' }),
      storage.put(buffers.optimized, { ...variant(image.optimizedKey), contentType: image.mimeType }),
      storage.put(buffers.thumbnail, { ...variant(image.thumbnailKey), contentType: image.mimeType }),
    ]);

    const photo = await PhotoModel.create({
      ...image,
      filename: `${baseName}.${image.mimeType === 'image/webp' ? 'webp' : 'jpg'}`,
      originalFilename: `${baseName}.jpg`,
      projectId: project._id,
      albumId: album._id,
      photographerId,
      clientId,
      exif: {
        camera: ['Sony A7 IV', 'Canon EOS R5', 'Nikon Z6 II'][n % 3] ?? 'Sony A7 IV',
        lens: ['35mm f/1.4', '85mm f/1.8', '24-70mm f/2.8'][n % 3] ?? '35mm f/1.4',
        iso: [100, 200, 400, 800][n % 4] ?? 200,
        aperture: ['f/1.8', 'f/2.8', 'f/4'][n % 3] ?? 'f/2.8',
        takenAt: eventDate,
      },
      capturedAt: eventDate,
      isHighlight: n < 12,
      highlightOrder: n,
      sortOrder: n,
      category: photoCategories[n % photoCategories.length] ?? 'other',
      caption: `Seeded frame ${n + 1}`,
      allowDownload: true,
    });

    await refreshPhotoCounts(photo._id);
    if (n === 0) {
      album.coverPhotoId = photo._id;
      project.coverPhotoId = photo._id;
    }
  }

  await album.save();
  await project.save();
  await refreshAlbumCounts(album._id);
  await refreshProjectCounts(project._id);

  await PortfolioItemModel.create({
    photographerId,
    title: `${booking.eventType} portfolio piece`,
    description: 'Seeded portfolio entry.',
    categoryKey: String(pkg.categoryKeys?.[0] ?? 'wedding'),
    imageKey: project.coverPhotoId
      ? (await PhotoModel.findById(project.coverPhotoId).select('optimizedKey thumbnailKey width height aspectRatio blurDataUrl optimizedSize mimeType').lean())?.optimizedKey ?? ''
      : '',
    thumbnailKey: project.coverPhotoId
      ? (await PhotoModel.findById(project.coverPhotoId).select('thumbnailKey').lean())?.thumbnailKey ?? ''
      : '',
    width: 1600,
    height: 1067,
    aspectRatio: 1.5,
    featured: input.index === 0,
    sortOrder: input.index,
    published: true,
    projectId: project._id,
  }).catch(() => undefined);

  const invoice = await InvoiceModel.create({
    invoiceNumber: `LF-INV-SEED${String(input.index + 1).padStart(4, '0')}`,
    bookingId: booking._id,
    projectId: project._id,
    clientId,
    photographerId,
    lines: [
      {
        description: String(pkg.name ?? 'Package'),
        quantity: 1,
        unitPriceMinor: totalMinor,
        totalMinor,
      },
    ],
    subtotalMinor: totalMinor,
    taxMinor: 0,
    totalMinor,
    paidMinor: 0,
    remainingMinor: totalMinor,
    currency: 'NPR',
    status: 'unpaid',
    dueDate: new Date(eventDate.getTime() - 7 * 86_400_000),
    depositDueMinor: depositMinor,
    balanceDueMinor: totalMinor - depositMinor,
  });

  if (depositMinor > 0) {
    const payment = await PaymentModel.create({
      reference: `LF-PAY-SEED${String(input.index + 1).padStart(3, '0')}`,
      bookingId: booking._id,
      projectId: project._id,
      invoiceId: invoice._id,
      clientId,
      photographerId,
      provider: 'mock',
      transactionId: `mock-seed-${input.index + 1}`,
      amountMinor: depositMinor,
      currency: 'NPR',
      paymentType: 'deposit',
      status: 'completed',
      verifiedAt: new Date(eventDate.getTime() - 18 * 86_400_000),
    });

    /* Credit the booking, invoice and timeline through the same path the gateway
     * uses. Writing the Payment row alone would leave the booking unpaid and the
     * invoice at zero while money was on record, so every dashboard number would
     * disagree with the payment history. */
    await applySuccessfulPayment(payment);
  }

  const conversation = await ConversationModel.create({
    photographerId,
    clientId,
    projectId: project._id,
    projectKey: String(project._id),
  });

  const seededMessages: { text: string; role: UserRole }[] = [
    { text: 'Hi! Are you free to confirm the start time for our shoot?', role: 'client' },
    { text: 'Confirmed. I will be at the venue an hour before the start time.', role: 'photographer' },
  ];

  for (const [n, message] of seededMessages.entries()) {
    await MessageModel.create({
      conversationId: conversation._id,
      photographerId,
      clientId,
      senderId: message.role === 'client' ? clientId : photographerId,
      senderRole: message.role,
      message: message.text,
      read: true,
      readAt: new Date(eventDate.getTime() - (9 - n) * 86_400_000),
      createdAt: new Date(eventDate.getTime() - (10 - n) * 86_400_000),
    });
  }

  conversation.messageCount = seededMessages.length;
  conversation.lastMessagePreview = seededMessages.at(-1)?.text ?? '';
  conversation.lastMessageSenderId = photographerId;
  conversation.lastMessageAt = new Date(eventDate.getTime() - 9 * 86_400_000);
  await conversation.save();

  if (input.index === 0) {
    await TestimonialModel.create({
      clientId,
      photographerId,
      projectId: project._id,
      bookingId: booking._id,
      rating: 5,
      title: 'Flawless from start to finish',
      content:
        'The whole team was calm and professional. We had our gallery within two weeks and it exceeded our expectations.',
      authorName: 'Seeded Client',
      eventType: booking.eventType,
      approved: true,
      approvedAt: new Date(),
      featured: true,
      requestedAt: new Date(),
    });
  }

  log.info('engagement seeded', { reference: booking.reference, photos: input.photos });
}

/** Deletes only this seed tenant's data. Never drops the database or a collection. */
async function resetSeedTenant(photographerId: Types.ObjectId, clientId: Types.ObjectId): Promise<void> {
  const tenant = { $or: [{ photographerId }, { clientId }] };

  /* Every id and storage key is collected up front: once the parent rows are
   * gone the child queries can no longer be scoped to this tenant. */
  const [projects, conversations, photos, portfolioItems] = await Promise.all([
    ProjectModel.find(tenant).select('_id').lean(),
    ConversationModel.find(tenant).select('_id').lean(),
    PhotoModel.find(tenant).select('originalKey optimizedKey thumbnailKey').lean(),
    PortfolioItemModel.find({ photographerId }).select('imageKey thumbnailKey').lean(),
  ]);
  const projectIds = projects.map((p) => p._id);
  const conversationIds = conversations.map((c) => c._id);

  /* Storage is not transactional, so orphaned bytes are removed explicitly.
   * Without this every `seed:reset` would leak a full gallery per run. */
  const storage = getStorage();
  const keys = [
    ...photos.flatMap((p) => [p.originalKey, p.optimizedKey, p.thumbnailKey]),
    ...portfolioItems.flatMap((p) => [p.imageKey, p.thumbnailKey]),
  ].filter((key): key is string => typeof key === 'string' && key.length > 0);
  for (const key of new Set(keys)) {
    try {
      await storage.delete(key);
    } catch (error) {
      log.warn('could not delete seeded object', { key, error: (error as Error).message });
    }
  }

  await Promise.all([
    PhotoModel.deleteMany(tenant),
    AlbumModel.deleteMany(tenant),
    TimelineEventModel.deleteMany({ projectId: { $in: projectIds } }),
    FavoriteModel.deleteMany(tenant),
    PhotoSelectionModel.deleteMany(tenant),
    PhotoCommentModel.deleteMany(tenant),
    GalleryShareModel.deleteMany(tenant),
    MessageModel.deleteMany({ conversationId: { $in: conversationIds } }),
    ConversationModel.deleteMany(tenant),
    NotificationModel.deleteMany({ userId: { $in: [photographerId, clientId] } }),
    TestimonialModel.deleteMany(tenant),
    PortfolioItemModel.deleteMany({ photographerId }),
    InvoiceModel.deleteMany(tenant),
    PaymentModel.deleteMany(tenant),
    ProjectModel.deleteMany({ _id: { $in: projectIds } }),
    BookingModel.deleteMany(tenant),
    AvailabilityBlockModel.deleteMany({ photographerId }),
    PackageModel.deleteMany({ photographerId }),
    ServiceModel.deleteMany({ photographerId }),
    AvailabilityRuleModel.deleteMany({ photographerId }),
    RefreshTokenModel.deleteMany({ userId: { $in: [photographerId, clientId] } }),
    VerificationTokenModel.deleteMany({ userId: { $in: [photographerId, clientId] } }),
    ClientProfileModel.deleteMany({ userId: clientId }),
    PhotographerProfileModel.deleteMany({ userId: photographerId }),
  ]);

  log.info('existing seed tenant removed', { photographerId, clientId, objects: keys.length });
}

async function main(): Promise<void> {
  await connectDatabase();

  const photographerPassword = argValue('--password') ?? env.SEED_PASSWORD;
  const adminPassword = argValue('--admin-password') ?? env.SEED_ADMIN_PASSWORD;

  const photographer = await upsertUser({
    email: SEED.photographerEmail,
    password: photographerPassword,
    name: 'Aarav Sharma',
    role: 'photographer',
    phone: '+9779800000001',
  });
  const client = await upsertUser({
    email: SEED.clientEmail,
    password: photographerPassword,
    name: 'Priya Karki',
    role: 'client',
    phone: '+9779800000002',
  });
  await upsertUser({
    email: SEED.adminEmail,
    password: adminPassword,
    name: 'LensFlow Admin',
    role: 'superadmin',
  });

  await upsertCategory();

  /* Reset first: it clears the photographer's packages, services, hours and
   * profiles, so re-creating them afterwards is what keeps `--reset` idempotent
   * instead of deleting the data the same run just wrote. */
  if (RESET) {
    await resetSeedTenant(photographer._id, client._id);
  }

  await ensurePhotographerProfile(photographer._id, 'Aarav Sharma Studio');
  await ensureClientProfile(client._id, photographer._id);
  await ensureWorkingHours(photographer._id);
  await ensurePackages(photographer._id);
  await ensureServices(photographer._id);

  const packages = await PackageModel.find({ photographerId: photographer._id }).sort({ sortOrder: 1 }).lean();

  const existing = await BookingModel.countDocuments({ photographerId: photographer._id });

  if (existing > 0 && !RESET) {
    log.info('seed tenant already has bookings; skipping engagement creation', { existing });
  } else {
    /* Photos are the slow part (sharp x N x 4 renditions), so only the first
     * engagement gets a full gallery; the rest get none, which keeps the seed
     * usable on a laptop while still exercising every other read path. */
    for (const [index, pkg] of packages.entries()) {
      await seedEngagement({
        photographerId: photographer._id,
        clientId: client._id,
        pkg: pkg as FlattenedPackage,
        daysAhead: 12 + index * 6,
        photos: index === 0 ? SEED.photosPerProject : 0,
        index,
      });
    }
  }

  const usage = await getStorage().usage();
  const counts = {
    users: await UserModel.countDocuments({}),
    categories: await CategoryModel.countDocuments({}),
    packages: await PackageModel.countDocuments({ photographerId: photographer._id }),
    services: await ServiceModel.countDocuments({ photographerId: photographer._id }),
    bookings: await BookingModel.countDocuments({ photographerId: photographer._id }),
    projects: await ProjectModel.countDocuments({ photographerId: photographer._id }),
    photos: await PhotoModel.countDocuments({ photographerId: photographer._id }),
    albums: await AlbumModel.countDocuments({ photographerId: photographer._id }),
    invoices: await InvoiceModel.countDocuments({ photographerId: photographer._id }),
    conversations: await ConversationModel.countDocuments({ photographerId: photographer._id }),
    messages: await MessageModel.countDocuments({ photographerId: photographer._id }),
    payments: await PaymentModel.countDocuments({ photographerId: photographer._id }),
    portfolio: await PortfolioItemModel.countDocuments({ photographerId: photographer._id }),
    testimonials: await TestimonialModel.countDocuments({ photographerId: photographer._id }),
  };

  await disconnectDatabase();

  /* Credentials are printed rather than written to disk: a seeded database with
   * fixed, publicly documented passwords must never look like a secret. */
  console.log('\nSeed complete.');
  console.log(`  photographer  ${SEED.photographerEmail}`);
  console.log(`  client        ${SEED.clientEmail}`);
  console.log(`  admin         ${SEED.adminEmail}`);
  console.log(`  shared client/photographer password  ${photographerPassword}`);
  console.log(`  admin password                      ${adminPassword}`);
  console.log(`  photos per project                  ${SEED.photosPerProject}`);
  console.log(`  stored objects                      ${usage.objects} (${(usage.bytes / 1024 / 1024).toFixed(1)} MB)`);
  console.log(`  ${JSON.stringify(counts)}`);
  console.log('\nThese accounts are for local development. Rotate or remove them before deploying.\n');
}

main().catch(async (error) => {
  log.error('seed failed', {
    message: error instanceof Error ? error.message : String(error),
    stack: error instanceof Error ? error.stack : undefined,
  });
  await disconnectDatabase().catch(() => undefined);
  process.exit(1);
});
