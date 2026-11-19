// typy importu plików SVG (logo integracji). `next-env.d.ts` z tym samym odwołaniem jest w .gitignore
// i powstaje dopiero przy `next dev`/`next build`, więc CI (typecheck przed buildem) bez tej linii nie zna `*.svg`.
/// <reference types="next/image-types/global" />
