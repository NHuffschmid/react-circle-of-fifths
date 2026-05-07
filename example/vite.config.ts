import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';

// react-piano-keyboard is a source-distributed peer dependency.
// Point to a sibling checkout: ../../../react-piano-keyboard
// Adjust this path to wherever you have react-piano-keyboard checked out.
const reactPianoKeyboardPath = path.resolve(__dirname, '../../../react-piano-keyboard/src');

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      'react-piano-keyboard': reactPianoKeyboardPath,
    },
  },
});
