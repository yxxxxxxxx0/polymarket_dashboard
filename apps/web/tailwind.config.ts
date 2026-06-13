import type { Config } from "tailwindcss";

const config: Config = {
  content: ["./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        ink: "#101820",
        panel: "#f7f9fb",
        line: "#dce3ea",
        buy: "#0f8b6d",
        sell: "#b42318",
        warn: "#b7791f"
      }
    }
  },
  plugins: []
};

export default config;
