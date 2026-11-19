/**
 * Public Pi Platform and Horizon endpoints, plus the `network` strings Pi puts on PaymentDTOs.
 *
 * Pi, Pi Network and the Pi logo are trademarks of the Pi Community Company.
 */

/** Official Pi Platform API. */
export const PI_API_BASE_URL = "https://api.minepi.com";

/** The `network` value Pi puts on payments for each `PI_NETWORK` setting. */
export const PI_NETWORK_NAMES = { testnet: "Pi Testnet", mainnet: "Pi Network" } as const;

/** Pi's public Horizon servers. */
export const PI_HORIZON_URLS = {
  testnet: "https://api.testnet.minepi.com",
  mainnet: "https://api.mainnet.minepi.com",
} as const;

export type PiNetwork = keyof typeof PI_NETWORK_NAMES;
export type PiNetworkName = (typeof PI_NETWORK_NAMES)[PiNetwork];
