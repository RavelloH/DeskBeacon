#define WIN32_LEAN_AND_MEAN
#ifndef UNICODE
#define UNICODE
#endif
#ifndef _UNICODE
#define _UNICODE
#endif
#include <windows.h>
#include <wchar.h>
#include <wctype.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Windows native process supervisor. Wire contract:
 * deskbeacon-job.exe base64(UTF8 JSON {"File","Args","Cwd","ParentPid"})
 * Uses CREATE_SUSPENDED -> AssignProcessToJobObject -> ResumeThread so a child
 * cannot run before the kill-on-close Job owns it. No CLR or external DLL. */

#define MAX_PAYLOAD (1024 * 1024)
#define MAX_ARGS 256
#define MAX_COMMAND_CHARS (256 * 1024)
typedef struct {
    wchar_t *file, *cwd;
    wchar_t *args[MAX_ARGS];
    int argc;
    DWORD parent;
} request_t;
static void fail(const char *message) {
    fprintf(stderr,"DESKBEACON_JOB_ERROR: %s (Win32=%lu)\n",message,(unsigned long)GetLastError());
}
static void *alloc_mem(size_t bytes) {
    void *p=calloc(1,bytes);
    if(!p){fail("Out of memory");ExitProcess(125);}
    return p;
}
static wchar_t *wide(const char *s) {
    int count=MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s,-1,NULL,0);
    if(!count)return NULL;
    wchar_t *out=alloc_mem((size_t)count*sizeof(wchar_t));
    if(!MultiByteToWideChar(CP_UTF8,MB_ERR_INVALID_CHARS,s,-1,out,count)){free(out);return NULL;}
    return out;
}
static wchar_t *copy_wide(const wchar_t *s){
    size_t n=wcslen(s);wchar_t *p=alloc_mem((n+1)*sizeof(wchar_t));memcpy(p,s,(n+1)*sizeof(wchar_t));return p;
}
static void skipws(const char **s){while(**s==' '||**s=='\t'||**s=='\r'||**s=='\n')(*s)++;}
static int hex4(const char **p){
    int n=0;
    for(int i=0;i<4;i++){
        char c=*(*p)++;int v=(c>='0'&&c<='9')?c-'0':(c>='a'&&c<='f')?c-'a'+10:(c>='A'&&c<='F')?c-'A'+10:-1;
        if(v<0)return -1;
        n=(n<<4)|v;
    }return n;
}
static int utf8out(char *out,size_t cap,size_t *n,unsigned v){
    if(v>0x10FFFF||(v>=0xD800&&v<=0xDFFF))return 0;
    int count=v<0x80?1:v<0x800?2:v<0x10000?3:4;
    if(*n+(size_t)count>=cap)return 0;
    if(count==1)out[(*n)++]=(char)v;
    else{
        if(count==2)out[(*n)++]=(char)(0xC0|(v>>6));
        else if(count==3)out[(*n)++]=(char)(0xE0|(v>>12));
        else out[(*n)++]=(char)(0xF0|(v>>18));
        if(count>=3)out[(*n)++]=(char)(0x80|((v>>6)&63));
        out[(*n)++]=(char)(0x80|(v&63));
    }
    return 1;
}
/* Decode a JSON string, including UTF-16 surrogate pairs, into UTF-8. */
static char *parse_string(const char **p,const char *end){
    if(*p>=end||*(*p)++!='"')return NULL;
    size_t cap=(size_t)(end-*p)+8,n=0;
    char *out=alloc_mem(cap);
    while(*p<end){
        unsigned char c=(unsigned char)*(*p)++;
        if(c=='"'){out[n]=0;return out;}
        if(c<' '){free(out);return NULL;}
        if(c!='\\'){out[n++]=(char)c;continue;}
        if(*p>=end){free(out);return NULL;}
        c=(unsigned char)*(*p)++;
        if(c=='u'){
            if(end-*p<4){free(out);return NULL;}
            int v=hex4(p);
            if(v<0){free(out);return NULL;}
            if(v>=0xD800&&v<=0xDBFF){
                if(end-*p<6||(*p)[0]!='\\'||(*p)[1]!='u'){free(out);return NULL;}
                *p+=2;int low=hex4(p);
                if(low<0xDC00||low>0xDFFF){free(out);return NULL;}
                v=0x10000+((v-0xD800)<<10)+(low-0xDC00);
            }
            if(!utf8out(out,cap,&n,(unsigned)v)){free(out);return NULL;}
        }else{
            const char replacement=c=='n'?'\n':c=='r'?'\r':c=='t'?'\t':c=='b'?'\b':c=='f'?'\f':(char)c;
            if(c!='n'&&c!='r'&&c!='t'&&c!='b'&&c!='f'&&c!='"'&&c!='\\'&&c!='/'){free(out);return NULL;}
            out[n++]=replacement;
        }
    }
    free(out);return NULL;
}
static char *base64(const wchar_t *encoded){
    size_t len=wcslen(encoded),cap=(len*3)/4+4,n=0;
    if(len>MAX_PAYLOAD*2)return NULL;
    char *out=alloc_mem(cap);
    unsigned acc=0;int bits=0;
    for(size_t i=0;i<len;i++){
        wchar_t c=encoded[i];if(c=='=')break;
        int v=(c>=L'A'&&c<=L'Z')?c-L'A':(c>=L'a'&&c<=L'z')?c-L'a'+26:
              (c>=L'0'&&c<=L'9')?c-L'0'+52:c==L'+'?62:c==L'/'?63:-1;
        if(v<0){free(out);return NULL;}
        acc=(acc<<6)|(unsigned)v;bits+=6;
        if(bits>=8){bits-=8;if(n>=MAX_PAYLOAD){free(out);return NULL;}out[n++]=(char)(acc>>bits);acc&=(1u<<bits)-1;}
    }out[n]=0;return out;
}
static int parse_request(const char *data,request_t *req){
    const char *p=data,*end=p+strlen(p);
    skipws(&p);if(p>=end||*p++!='{')return 0;
    while(1){
        skipws(&p);if(p>=end)return 0;if(*p=='}'){p++;break;}
        char *key=parse_string(&p,end);if(!key)return 0;
        skipws(&p);if(p>=end||*p++!=':'){free(key);return 0;}skipws(&p);
        int ok=1;
        if(!strcmp(key,"Args")){
            if(p>=end||*p++!='[')ok=0;
            else{
                skipws(&p);
                while(ok&&p<end&&*p!=']'){
                    if(req->argc>=MAX_ARGS){ok=0;break;}
                    char *value=parse_string(&p,end);if(!value){ok=0;break;}
                    req->args[req->argc]=wide(value);free(value);
                    if(!req->args[req->argc++])ok=0;
                    skipws(&p);
                    if(*p==','){p++;skipws(&p);}else if(*p!=']')ok=0;
                }
                if(p>=end||*p++!=']')ok=0;
            }
        }else if(!strcmp(key,"ParentPid")){
            char *finish=NULL;unsigned long v=strtoul(p,&finish,10);
            if(finish==p||v==0||v>0xFFFFFFFFu)ok=0;
            else{req->parent=(DWORD)v;p=finish;}
        }else if(!strcmp(key,"File")||!strcmp(key,"Cwd")){
            char *value=parse_string(&p,end);
            wchar_t *valueW=value?wide(value):NULL;free(value);
            if(!valueW)ok=0;
            else if(!strcmp(key,"File"))req->file=valueW;
            else req->cwd=valueW;
        }else ok=0;
        free(key);if(!ok)return 0;
        skipws(&p);if(p>=end)return 0;
        if(*p==','){p++;continue;}
        if(*p=='}'){p++;break;}
        return 0;
    }
    skipws(&p);
    return p==end&&req->file&&req->file[0]&&req->cwd&&req->parent;
}
static int exists_file(const wchar_t *path){
    DWORD flags=GetFileAttributesW(path);
    return flags!=INVALID_FILE_ATTRIBUTES&&!(flags&FILE_ATTRIBUTE_DIRECTORY);
}
static wchar_t *concat3(const wchar_t *a,const wchar_t *b,const wchar_t *c){
    size_t size=wcslen(a)+wcslen(b)+wcslen(c)+1;
    wchar_t *out=alloc_mem(size*sizeof(wchar_t));
    wcscpy(out,a);wcscat(out,b);wcscat(out,c);return out;
}
static wchar_t *canonical_path(const wchar_t *path){
    DWORD needed=GetFullPathNameW(path,0,NULL,NULL);if(!needed)return NULL;
    wchar_t *result=alloc_mem(((size_t)needed+1)*sizeof(wchar_t));
    if(!GetFullPathNameW(path,needed+1,result,NULL)){free(result);return NULL;}
    return result;
}
static wchar_t *try_program(const wchar_t *name){
    static const wchar_t *exts[]={L".exe",L".com",L".cmd",L".bat",L""};
    const wchar_t *slash=wcsrchr(name,L'\\'),*back=wcsrchr(name,L'/');
    const wchar_t *base=slash&&(!back||slash>back)?slash+1:back?back+1:name;
    int has_extension=wcschr(base,L'.')!=NULL;
    for(int i=has_extension?4:0;i<5;i++){
        wchar_t *candidate=concat3(name,L"",exts[i]);
        if(exists_file(candidate)){wchar_t *out=canonical_path(candidate);free(candidate);return out;}
        free(candidate);
    }
    return NULL;
}
static wchar_t *resolve_program(const wchar_t *file,const wchar_t *cwd){
    int pathlike=wcschr(file,L'\\')||wcschr(file,L'/')||wcschr(file,L':');
    if(pathlike){
        wchar_t *candidate=pathlike&&!(wcslen(file)>1&&file[1]==L':')&&file[0]!=L'\\'
            ?concat3(cwd,L"\\",file):copy_wide(file);
        wchar_t *found=try_program(candidate);free(candidate);return found;
    }
    DWORD need=GetEnvironmentVariableW(L"PATH",NULL,0);
    if(!need)return NULL;
    wchar_t *paths=alloc_mem(((size_t)need+1)*sizeof(wchar_t));
    GetEnvironmentVariableW(L"PATH",paths,need+1);
    wchar_t *cursor=paths;
    while(*cursor){
        wchar_t *end=wcschr(cursor,L';');if(end)*end=0;
        wchar_t *part=cursor;while(*part==L' '||*part==L'"')part++;
        size_t n=wcslen(part);
        while(n&&(part[n-1]==L' '||part[n-1]==L'"'))part[--n]=0;
        if(n){
            wchar_t *candidate=concat3(part,L"\\",file);
            wchar_t *found=try_program(candidate);
            free(candidate);
            if(found){free(paths);return found;}
        }
        if(!end)break;
        cursor=end+1;
    }
    free(paths);return NULL;
}
static int is_batch(const wchar_t *exe){
    const wchar_t *extension=wcsrchr(exe,L'.');
    return extension&&(!_wcsicmp(extension,L".bat")||!_wcsicmp(extension,L".cmd"));
}
/* Windows documented command-line quoting, including trailing backslashes. */
typedef struct {wchar_t *s;size_t len,cap;} buf_t;
static void add_char(buf_t *b,wchar_t c){
    if(b->len+2>b->cap){b->cap=b->cap?b->cap*2:256;if(b->cap>MAX_COMMAND_CHARS)ExitProcess(125);b->s=realloc(b->s,b->cap*sizeof(wchar_t));if(!b->s)ExitProcess(125);}
    b->s[b->len++]=c;b->s[b->len]=0;
}
static void add_string(buf_t *b,const wchar_t *s){while(*s)add_char(b,*s++);}
static void quote_arg(buf_t *b,const wchar_t *str){
    if(*str&&!wcspbrk(str,L" \t\n\v\"")){add_string(b,str);return;}
    add_char(b,L'"');
    int slash=0;
    for(const wchar_t *s=str;;s++){
        if(*s==L'\\'){slash++;continue;}
        if(*s==L'"'||!*s){
            for(int k=0;k<slash*(*s?2:2);k++)add_char(b,L'\\');
            slash=0;
            if(!*s)break;
            add_char(b,L'\\');add_char(b,L'"');
        }else{
            for(int k=0;k<slash;k++)add_char(b,L'\\');
            slash=0;
            add_char(b,*s);
        }
    }add_char(b,L'"');
}
static DWORD WINAPI monitor_parent(void *value){
    HANDLE parent=(HANDLE)value;
    WaitForSingleObject(parent,INFINITE);
    ExitProcess(125);return 0;
}
typedef struct {HANDLE source,target;} copy_t;
static DWORD WINAPI copy_stream(void *raw){
    copy_t *ctx=(copy_t *)raw;char block[65536];DWORD n=0,used=0;
    while(ReadFile(ctx->source,block,sizeof(block),&n,NULL)&&n){
        used=0;while(used<n){
            DWORD step=0;
            if(!WriteFile(ctx->target,block+used,n-used,&step,NULL)||!step)return 0;
            used+=step;
        }
    }return 0;
}
static void close_valid(HANDLE *handle){if(*handle&&*handle!=INVALID_HANDLE_VALUE){CloseHandle(*handle);*handle=NULL;}}
static int run(const request_t *req){
    int result=125;HANDLE job=NULL,parent=NULL,childProcess=NULL,childThread=NULL;
    HANDLE stdinRead=NULL,stdinWrite=NULL,stdoutRead=NULL,stdoutWrite=NULL,stderrRead=NULL,stderrWrite=NULL;
    HANDLE outThread=NULL,errThread=NULL,inThread=NULL,monitor=NULL;
    wchar_t *exe=resolve_program(req->file,req->cwd);
    wchar_t *cwd=canonical_path(req->cwd);
    wchar_t *cmdExe=NULL;buf_t command={0};int launched=0;
    if(!exe||!cwd){fail("Program or working directory not found");goto cleanup;}
    if(is_batch(exe)){
        for(int n=0;n<req->argc;n++){
            if(wcspbrk(req->args[n],L"\"%!^&|<>\r\n")){fail("Unsafe batch arguments; use an explicit shell profile");goto cleanup;}
        }
        cmdExe=resolve_program(L"cmd.exe",cwd);
        if(!cmdExe){fail("cmd.exe not found");goto cleanup;}
        quote_arg(&command,cmdExe);add_string(&command,L" /d /s /c \"");
        quote_arg(&command,exe);
        for(int n=0;n<req->argc;n++){add_char(&command,L' ');quote_arg(&command,req->args[n]);}
        add_char(&command,L'"');
    }else{
        quote_arg(&command,exe);
        for(int n=0;n<req->argc;n++){add_char(&command,L' ');quote_arg(&command,req->args[n]);}
    }
    parent=OpenProcess(SYNCHRONIZE,FALSE,req->parent);
    if(!parent){fail("OpenProcess(parent)");goto cleanup;}
    monitor=CreateThread(NULL,0,monitor_parent,parent,0,NULL);
    if(!monitor){fail("CreateThread(parent)");goto cleanup;}
    job=CreateJobObjectW(NULL,NULL);
    if(!job){fail("CreateJobObjectW");goto cleanup;}
    JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits={0};
    limits.BasicLimitInformation.LimitFlags=JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE|JOB_OBJECT_LIMIT_ACTIVE_PROCESS;
    limits.BasicLimitInformation.ActiveProcessLimit=128;
    if(!SetInformationJobObject(job,JobObjectExtendedLimitInformation,&limits,sizeof(limits))){fail("SetInformationJobObject");goto cleanup;}
    SECURITY_ATTRIBUTES sa={sizeof(sa),NULL,TRUE};
    if(!CreatePipe(&stdinRead,&stdinWrite,&sa,0)||!CreatePipe(&stdoutRead,&stdoutWrite,&sa,0)||
       !CreatePipe(&stderrRead,&stderrWrite,&sa,0)){fail("CreatePipe");goto cleanup;}
    if(!SetHandleInformation(stdinWrite,HANDLE_FLAG_INHERIT,0)||
       !SetHandleInformation(stdoutRead,HANDLE_FLAG_INHERIT,0)||
       !SetHandleInformation(stderrRead,HANDLE_FLAG_INHERIT,0)){fail("SetHandleInformation");goto cleanup;}
    STARTUPINFOW si={0};si.cb=sizeof(si);si.dwFlags=STARTF_USESTDHANDLES;
    si.hStdInput=stdinRead;si.hStdOutput=stdoutWrite;si.hStdError=stderrWrite;
    PROCESS_INFORMATION pi={0};
    if(!CreateProcessW(cmdExe?cmdExe:exe,command.s,NULL,NULL,TRUE,
           CREATE_SUSPENDED|CREATE_UNICODE_ENVIRONMENT|CREATE_NO_WINDOW,NULL,cwd,&si,&pi)){
        fail("CreateProcessW");goto cleanup;
    }
    launched=1;childProcess=pi.hProcess;childThread=pi.hThread;
    if(!AssignProcessToJobObject(job,childProcess)){fail("AssignProcessToJobObject");goto cleanup;}
    if(ResumeThread(childThread)==(DWORD)-1){fail("ResumeThread");goto cleanup;}
    close_valid(&childThread);close_valid(&stdinRead);close_valid(&stdoutWrite);close_valid(&stderrWrite);
    copy_t ioOut={stdoutRead,GetStdHandle(STD_OUTPUT_HANDLE)};
    copy_t ioErr={stderrRead,GetStdHandle(STD_ERROR_HANDLE)};
    copy_t ioIn={GetStdHandle(STD_INPUT_HANDLE),stdinWrite};
    outThread=CreateThread(NULL,0,copy_stream,&ioOut,0,NULL);
    errThread=CreateThread(NULL,0,copy_stream,&ioErr,0,NULL);
    inThread=CreateThread(NULL,0,copy_stream,&ioIn,0,NULL);
    if(!outThread||!errThread||!inThread){fail("CreateThread(pipe)");goto cleanup;}
    if(WaitForSingleObject(childProcess,INFINITE)!=WAIT_OBJECT_0){fail("WaitForSingleObject(child)");goto cleanup;}
    DWORD childExit=125;
    if(!GetExitCodeProcess(childProcess,&childExit)){fail("GetExitCodeProcess");goto cleanup;}
    /* Closing the job also kills any grandchildren after the root command exits. */
    close_valid(&job);
    if(outThread)WaitForSingleObject(outThread,5000);
    if(errThread)WaitForSingleObject(errThread,5000);
    result=(int)childExit;
cleanup:
    if(launched&&childThread)TerminateProcess(childProcess,125);
    close_valid(&job);close_valid(&stdinRead);close_valid(&stdinWrite);
    close_valid(&stdoutRead);close_valid(&stdoutWrite);close_valid(&stderrRead);close_valid(&stderrWrite);
    close_valid(&childThread);close_valid(&childProcess);
    /* watchdog uses parent handle until ExitProcess, do not close it early. */
    close_valid(&outThread);close_valid(&errThread);close_valid(&inThread);close_valid(&monitor);
    free(exe);free(cwd);free(cmdExe);free(command.s);
    return result;
}
int wmain(int argc,wchar_t **argv){
    if(argc!=2){fprintf(stderr,"Usage: deskbeacon-job <base64-JSON>\n");return 125;}
    char *payload=base64(argv[1]);
    if(!payload){fail("Invalid base64 command payload");return 125;}
    request_t req={0};
    if(!parse_request(payload,&req)){fail("Invalid JSON command payload");free(payload);return 125;}
    free(payload);
    return run(&req);
}
