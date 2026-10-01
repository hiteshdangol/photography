export interface ApiEnvelope<T> {
  success: true;
  message: string;
  data: T;
  meta?: Record<string, unknown>;
}

export interface ApiErrorBody {
  success: false;
  message: string;
  code?: string;
  details?: unknown;
}

export type Role = 'superadmin' | 'photographer' | 'client';

export interface SessionUser {
  id: string;
  name: string;
  email: string;
  phone?: string | null;
  avatar?: string | null;
  role: Role;
  status: string;
  emailVerified: boolean;
  createdAt: string;
}

export interface PhotographerProfile {
  id: string;
  userId: string;
  businessName: string;
  slug: string;
  tagline: string;
  bio: string;
  location: string;
  specialties: string[];
  profileImage: string | null;
  coverImage: string | null;
  portfolioCover: string | null;
  startingPrice: number;
  rating: { average: number; count: number };
  published: boolean;
  featured: boolean;
  social?: { website: string; instagram: string; facebook: string; whatsapp: string };
}

export interface ClientProfile {
  id: string;
  userId: string;
  fullName: string;
  photographerIds: string[];
}

/** `/auth/me` returns the user plus whichever profile matches their role. */
export interface MeResponse {
  user: SessionUser & {
    slug?: string | null;
    photographerProfile?: PhotographerProfile | null;
    clientProfile?: ClientProfile | null;
  };
}

export interface AuthResponse {
  user: SessionUser;
  accessToken: string;
  expiresIn: string;
}

export interface Paginated<T> {
  items: T[];
  total: number;
  page: number;
  limit: number;
  totalPages: number;
}
