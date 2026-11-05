/// <reference types="vite/client" />

// Shared JavaScript SFCs are consumed alongside the app's typed Vue components.
declare module "*.vue" {
  import type { DefineComponent } from "vue";
  const component: DefineComponent;
  export default component;
}
