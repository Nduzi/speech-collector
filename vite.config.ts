import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// base "./" lets the same build work at https://<user>.github.io/<repo>/ and on any other static host
export default defineConfig({ base: "./", plugins: [react()], build: { outDir: "dist", sourcemap: false }, test: { environment: "node" } });
