export type SessionCookies = Readonly<{
  rawSession: string;
  csrf: string;
  cookieHeader: string;
}>;
