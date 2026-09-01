// @ts-check
// Entry point.

import { fishing, init } from './fishing/index.js';
import { system, world, ItemStack } from '@minecraft/server';

init();

// ===== beforeEvents.catch =====
// Chạy TRƯỚC khi detector xử lý. Subscriber có thể mutate event nhiều lần —
// chỉ trạng thái CUỐI CÙNG mới quyết định. Thứ tự ưu tiên:
//   1. event.cancel = true               → huỷ (kill gốc, no afterEvents)
//   2. event.item = null / object invalid → LỖI: bị ignore + warning + dùng gốc
//   3. event.item = entityKhác (hợp lệ)  → thay thế (kill gốc, auto-throw,
//                                          afterEvents với entity mới)
//   4. event.item = entityGốc / không đổi → giữ (giữ gốc, afterEvents với gốc)
//
// Trong ví dụ này: thay mọi item câu được bằng 1 viên kim cương.
// (Trước đây logic này hardcoded trong detector — giờ chuyển cho consumer qua beforeEvents.)
/** @param {import('./fishing/types.js').FishingCatchBeforeEvent} event */
fishing.beforeEvents.catch.subscribe((event) => {
  // Mặc định: GIỮ item gốc (cá). Muốn thay → set event.item. Muốn huỷ →
  // set event.cancel = true (ưu tiên cao nhất, kể cả khi đã gán event.item).
  // QUAN TRỌNG: detector check event.cancel SAU khi trigger signal. Nếu
  // subscriber vừa set cancel=true vừa spawn entity → entity đã spawn, không
  // có cách undo. Subscriber phải TỰ CHECK cancel trước khi spawn.
  const { dimension, location } = event;
  if (event.cancel === true) return;
  const diamond = dimension.spawnItem(new ItemStack('minecraft:diamond', 1), location);
  try { diamond.setDynamicProperty('fishing_reward', true); } catch { /* ignore */ }
  event.item = diamond;
});

// ===== afterEvents.catch =====
// Chỉ phát khi beforeEvents KHÔNG cancel.
// event.items đã đồng bộ với trạng thái cuối của beforeEvents (entity mới nếu
// được thay thế, entity gốc nếu giữ nguyên hoặc fallback do item invalid).
/** @param {import('./fishing/types.js').FishingCatchEvent} event */
fishing.afterEvents.catch.subscribe((event) => {
  const player = event.player;
  const names = event.items.map((i) => i.itemTypeId).join(', ');
  // afterEvents chạy trên internal thread; marshal sendMessage về main thread
  system.run(() => {
    player.sendMessage(`§aBạn đã câu được: §f${names}`);
  });
});

// ===== afterEvents.cancel =====
// Phát khi event.cancel = true trong beforeEvents (subscriber chủ động huỷ catch).
// KHÔNG phát khi event.item bị set null/invalid — case đó bị ignore và fall
// back về entity gốc (giống vanilla events khi mutation sai).
/** @param {import('./fishing/types.js').FishingCancelEvent} event */
fishing.afterEvents.cancel.subscribe((event) => {
  if (event.reason === 'CANCELLED') {
    const player = event.playerId ? world.getEntity(event.playerId) : undefined;
    if (player && player.typeId === 'minecraft:player') {
      system.run(() => {
        player.sendMessage(`§cCatch đã bị huỷ.`);
      });
    }
  }
});
