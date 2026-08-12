export type IslandButtonDimmer = (dimmed: boolean) => void;

let islandButtonDimmer: IslandButtonDimmer = () => {};

export const bindIslandButtonDimmer = (dimmer: IslandButtonDimmer): void => {
  islandButtonDimmer = dimmer;
};

export const setIslandButtonDimmed = (dimmed: boolean): void => {
  islandButtonDimmer(dimmed);
};
