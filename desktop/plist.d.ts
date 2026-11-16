declare module "plist" {
  const plist: { parse(source: string): unknown };
  export default plist;
}
