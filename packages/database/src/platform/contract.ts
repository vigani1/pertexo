export type DatabaseReadiness = Readonly<{
  migrationHead: string;
  postgresMajor: number;
  role: string;
}>;
