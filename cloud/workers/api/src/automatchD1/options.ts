export type AutomatchD1StoreOptions = {
  now?: () => number;
  writeGuards?: () => readonly D1PreparedStatement[];
};
