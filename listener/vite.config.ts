import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';

const reactPianoKeyboardPath = path.resolve(__dirname, '../../react-piano-keyboard/src');

export default defineConfig({
  base: '/circle-of-fifths/',
  plugins: [react()],
  resolve: {
    alias: {
      'react-piano-keyboard': reactPianoKeyboardPath,
    },
  },
});
