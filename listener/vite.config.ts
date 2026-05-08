import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react-swc';
import path from 'path';

const reactPianoKeyboardPath = process.env.REACT_PIANO_KEYBOARD_PATH
  ? path.resolve(__dirname, process.env.REACT_PIANO_KEYBOARD_PATH)
  : path.resolve(__dirname, '../../react-piano-keyboard/src');
const reactPath = path.resolve(__dirname, 'node_modules/react');
const reactDomPath = path.resolve(__dirname, 'node_modules/react-dom');

export default defineConfig({
  base: '/circle-of-fifths/',
  plugins: [react()],
  resolve: {
    alias: {
      'react-piano-keyboard': reactPianoKeyboardPath,
      'react': reactPath,
      'react-dom': reactDomPath,
    },
  },
});
