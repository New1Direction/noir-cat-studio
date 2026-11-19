import { defineConfig } from 'vite';

// Keep exported builds portable across root sites and GitHub Pages project paths.
export default defineConfig({ base: './' });
