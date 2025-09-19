declare module 'gi://*' {
  const giModule: any;
  export default giModule;
}

declare module 'resource://*' {
  const resourceModule: any;
  export = resourceModule;
}

declare const global: any;
