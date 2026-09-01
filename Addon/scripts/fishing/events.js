// @ts-check
// Public fishing namespace — bridges signals từ detector.

import { catchSignal, castSignal, reelSignal, cancelSignal, beforeCatchSignal, FishingEventSignal } from './detector.js';

export { FishingEventSignal };

export const fishing = {
  beforeEvents: {
    catch: beforeCatchSignal,
  },
  afterEvents: {
    cast: castSignal,
    reel: reelSignal,
    catch: catchSignal,
    cancel: cancelSignal,
  },
};
