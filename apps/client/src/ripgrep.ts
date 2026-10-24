// The VS Code ripgrep package does not publish an android-arm64 binary.
// Loading it eagerly prevents the entire CLI from starting on Termux.
// Termux's native rg package is the correct executable there.
export async function ripgrepExecutable(platform=process.platform):Promise<string>{
 if(platform==='android')return 'rg';
 try{
  const {rgPath}=await import('@vscode/ripgrep');
  return rgPath;
 }catch{
  // Use an rg already installed on PATH when a platform package is unavailable.
  return 'rg';
 }
}
