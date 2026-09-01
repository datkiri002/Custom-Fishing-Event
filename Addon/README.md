# Custom Fishing Event — Minecraft Bedrock 1.26+ Addon

Script API addon phát hiện custom fishing events với multi-evidence owner association.

## Cấu trúc

```
Addon/
├── manifest.json
└── scripts/
    ├── import.js                      # Entry point + consumer examples
    └── fishing/
        ├── config.js                  # Constants, weights, thresholds
        ├── types.js                   # JSDoc typedefs
        ├── detector.js                # Stage 1 (Cast→Hook) + Stage 2 (Hook→Item)
        ├── events.js                  # Public FishingEventSignal API
        └── index.js                   # Public exports
```

## Public API

```js
import { fishing, init } from './fishing/index.js';

init();

fishing.beforeEvents.catch.subscribe((event) => {
  // event.item = replacement (kill original)
  // event.cancel = true (huỷ catch, no afterEvents)
});

fishing.afterEvents.catch.subscribe((event) => {
  // event.items: CaughtItem[] (replaced or original)
});

fishing.afterEvents.cancel.subscribe((event) => {
  // event.reason: 'CANCELLED' | 'OWNER_GONE' | 'EMPTY_REEL'
});
```

## Stage 1: Cast → Hook Owner Association

Multi-evidence scoring với 7 nhóm (tổng 1000 điểm):
- **Temporal** (150): cast time → hook spawn tick
- **Spatial** (200): cast location → hook location
- **Ray Projection** (200): perpendicular error từ ray view→hook
- **Angular** (150): angle giữa viewDirection và hookVelocity
- **Hook Velocity** (100): hook bay xa (magnitude)
- **Player Momentum** (100): player đứng yên khi cast
- **Before→After** (100): player drift từ cast → spawn

**Confidence states**:
- `CONFIRMED`: score ≥ 600 AND margin ≥ 150
- `AMBIGUOUS`: score ≥ 400 AND margin ≥ 50
- `UNKNOWN`: top score thấp hoặc margin không đủ → fallback
- `FALLBACK`: heuristic (player gần + cast gần)

## Stage 2: Hook → Item Correlation

`scoreMatch` với 6 dimensions: session association, time proximity, tick proximity, hook distance, player distance, trajectory, ray alignment.

## Versioning

`detector.js` log `detector initialized v<YYYY-MM-DD>-<tag>` mỗi lần reload để verify pack mới.

## License

Private.
