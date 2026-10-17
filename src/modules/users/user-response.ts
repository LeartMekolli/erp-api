/**
 * The only shape a user leaves the API in: an allow-list, so a column added
 * later (a hash, a secret) stays out of responses unless someone adds it here
 * (spec 4.8).
 */
export interface UserResponse {
  id: string;
  email: string;
  name: string;
  status: string;
  locale: string;
  created_at: string;
}

export function toUserResponse(user: {
  id: string;
  email: string;
  name: string;
  status: string;
  locale: string;
  createdAt: Date;
}): UserResponse {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    status: user.status,
    locale: user.locale,
    created_at: user.createdAt.toISOString(),
  };
}
