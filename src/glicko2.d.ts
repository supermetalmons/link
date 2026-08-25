declare module "glicko2" {
  import type { RatingCalculatorConstructor } from "@mons/shared/ratings";

  const glicko2: {
    Glicko2: RatingCalculatorConstructor;
  };

  export default glicko2;
}
