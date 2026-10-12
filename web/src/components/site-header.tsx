import { readBasket } from "@/lib/basket-server";

import { HeaderBar, type HeaderPage } from "./header-bar";

/** `current` marks the page you are on, for screen readers and the underline. */
export async function SiteHeader({ current }: { current?: HeaderPage } = {}) {
  const basket = await readBasket();
  return <HeaderBar current={current} items={basket.size} />;
}
