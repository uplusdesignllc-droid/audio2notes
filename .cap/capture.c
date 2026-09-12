/*
 * capture.c — WASAPI audio capture tool for Audio2Notes (mingw gcc, C11).
 * Subcommands:
 *   capture.exe list
 *   capture.exe record system <out.wav> [--seconds N]
 *   capture.exe record mic    <out.wav> [--seconds N]
 *
 * system = WASAPI loopback on the default render (eConsole) device (what you hear).
 * mic    = plain capture from the default capture (eConsole) device.
 *
 * stdout lines: READY fmt=<rate>:<ch>:<bits> | LEVEL <0..100> | FINISHED bytes=<n> dur=<s>
 * stderr lines: ERR <message>
 *
 * mingw C-mode notes: no inline wrappers (C++ only) -> use lpVtbl directly.
 */
#include <windows.h>
#include <mmdeviceapi.h>
#include <audioclient.h>
#include <audiopolicy.h>
#include <endpointvolume.h>
#include <propsys.h>
#include <propkey.h>
#include <functiondiscoverykeys_devpkey.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>

static volatile LONG g_stop = 0;
static FILE* g_status = NULL; /* optional --status <file>; mirrors stdout lines */
static const char* g_stop_file = NULL; /* optional --stop <file>; graceful stop signal */

static int stop_requested(void) {
  if (g_stop) return 1;
  if (g_stop_file) {
    WIN32_FILE_ATTRIBUTE_DATA fa;
    if (GetFileAttributesExA(g_stop_file, GetFileExInfoStandard, &fa)) return 1;
  }
  return 0;
}

static void emit(const char* fmt, ...) {
  va_list ap;
  va_start(ap, fmt);
  vprintf(fmt, ap);
  va_end(ap);
  fflush(stdout);
  if (g_status) {
    va_start(ap, fmt);
    vfprintf(g_status, fmt, ap);
    va_end(ap);
    fflush(g_status);
  }
}

static BOOL WINAPI on_ctrl(DWORD ev) {
  (void)ev;
  InterlockedExchange(&g_stop, 1);
  return TRUE;
}

static void fail(const char* msg, HRESULT hr) {
  fprintf(stderr, "ERR %s (0x%08lx)\n", msg, (unsigned long)hr);
  exit(1);
}

/* ---- device enumeration -------------------------------------------------- */

static void print_devices(EDataFlow flow, const char* label) {
  IMMDeviceEnumerator* en = NULL;
  HRESULT hr = CoCreateInstance(&CLSID_MMDeviceEnumerator, NULL, CLSCTX_INPROC_SERVER,
                                &IID_IMMDeviceEnumerator, (void**)&en);
  if (FAILED(hr)) fail("CoCreateInstance MMDeviceEnumerator", hr);
  IMMDeviceCollection* coll = NULL;
  hr = en->lpVtbl->EnumAudioEndpoints(en, flow, DEVICE_STATE_ACTIVE, &coll);
  if (FAILED(hr)) { en->lpVtbl->Release(en); fail("EnumAudioEndpoints", hr); }
  UINT n = 0;
  coll->lpVtbl->GetCount(coll, &n);
  for (DWORD i = 0; i < n; i++) {
    IMMDevice* dev = NULL;
    if (FAILED(coll->lpVtbl->Item(coll, i, &dev))) continue;
    LPWSTR id = NULL;
    WCHAR name[512] = L"";
    if (SUCCEEDED(dev->lpVtbl->GetId(dev, &id)) && id) {
      IPropertyStore* ps = NULL;
      if (SUCCEEDED(dev->lpVtbl->OpenPropertyStore(dev, STGM_READ, &ps))) {
        PROPVARIANT pv; PropVariantInit(&pv);
        if (SUCCEEDED(ps->lpVtbl->GetValue(ps, &PKEY_Device_FriendlyName, &pv)) &&
            pv.vt == VT_LPWSTR && pv.pwszVal) {
          wcsncpy(name, pv.pwszVal, 511);
        }
        PropVariantClear(&pv);
        ps->lpVtbl->Release(ps);
      }
      emit("DEV %s\t%ls\t%ls\n", label, name, id);
      CoTaskMemFree(id);
    }
    dev->lpVtbl->Release(dev);
  }
  coll->lpVtbl->Release(coll);
  en->lpVtbl->Release(en);
}

static int cmd_list(void) {
  CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
  print_devices(eRender, "system");
  print_devices(eCapture, "mic");
  CoUninitialize();
  return 0;
}

/* ---- audio session enumeration ------------------------------------------
 * "sessions" answers one question: which PROCESSES are currently producing
 * sound on the default output device, and are their sessions Active?
 * The app uses it to notice that a Teams/Zoom/Webex call started or ended, so
 * recording can begin/stop without the user pressing anything.
 * Output: SESSION pid=<n> state=<Active|Inactive|Expired> peak=<0..1> name=<exe>
 * ------------------------------------------------------------------------- */

static void process_name(DWORD pid, char* out, size_t n) {
  out[0] = '\0';
  if (pid == 0) { snprintf(out, n, "(system)"); return; }
  HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, pid);
  if (!h) { snprintf(out, n, "pid%lu", (unsigned long)pid); return; }
  WCHAR path[MAX_PATH] = L"";
  DWORD len = MAX_PATH;
  if (QueryFullProcessImageNameW(h, 0, path, &len)) {
    const WCHAR* base = wcsrchr(path, L'\\');
    base = base ? base + 1 : path;
    if (WideCharToMultiByte(CP_UTF8, 0, base, -1, out, (int)n - 1, NULL, NULL) == 0) out[0] = '\0';
    out[n - 1] = '\0';
  } else {
    snprintf(out, n, "pid%lu", (unsigned long)pid);
  }
  CloseHandle(h);
}

static int cmd_sessions(void) {
  CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
  IMMDeviceEnumerator* en = NULL;
  HRESULT hr = CoCreateInstance(&CLSID_MMDeviceEnumerator, NULL, CLSCTX_INPROC_SERVER,
                                &IID_IMMDeviceEnumerator, (void**)&en);
  if (FAILED(hr)) fail("CoCreateInstance MMDeviceEnumerator", hr);

  IMMDevice* dev = NULL;
  hr = en->lpVtbl->GetDefaultAudioEndpoint(en, eRender, eConsole, &dev);
  if (FAILED(hr)) { en->lpVtbl->Release(en); fail("GetDefaultAudioEndpoint", hr); }

  IAudioSessionManager2* mgr = NULL;
  hr = dev->lpVtbl->Activate(dev, &IID_IAudioSessionManager2, CLSCTX_ALL, NULL, (void**)&mgr);
  if (FAILED(hr)) { dev->lpVtbl->Release(dev); en->lpVtbl->Release(en); fail("Activate IAudioSessionManager2", hr); }

  IAudioSessionEnumerator* ses = NULL;
  hr = mgr->lpVtbl->GetSessionEnumerator(mgr, &ses);
  if (FAILED(hr)) fail("GetSessionEnumerator", hr);

  int count = 0;
  ses->lpVtbl->GetCount(ses, &count);
  for (int i = 0; i < count; i++) {
    IAudioSessionControl* ctl = NULL;
    if (FAILED(ses->lpVtbl->GetSession(ses, i, &ctl)) || !ctl) continue;

    AudioSessionState st = AudioSessionStateExpired;
    ctl->lpVtbl->GetState(ctl, &st);

    DWORD pid = 0;
    IAudioSessionControl2* ctl2 = NULL;
    if (SUCCEEDED(ctl->lpVtbl->QueryInterface(ctl, &IID_IAudioSessionControl2, (void**)&ctl2)) && ctl2) {
      ctl2->lpVtbl->GetProcessId(ctl2, &pid);
    }

    char pname[260];
    process_name(pid, pname, sizeof(pname));
    const char* sname = (st == AudioSessionStateActive) ? "Active"
                      : (st == AudioSessionStateInactive) ? "Inactive" : "Expired";
    emit("SESSION pid=%lu state=%s name=%s\n", (unsigned long)pid, sname, pname);

    if (ctl2) ctl2->lpVtbl->Release(ctl2);
    ctl->lpVtbl->Release(ctl);
  }

  ses->lpVtbl->Release(ses);
  mgr->lpVtbl->Release(mgr);
  dev->lpVtbl->Release(dev);
  en->lpVtbl->Release(en);
  CoUninitialize();
  return 0;
}

/* ---- recording ----------------------------------------------------------- */

typedef struct { DWORD rate; WORD channels; WORD bits; int is_float; } FmtInfo;

/* KSDATAFORMAT_SUBTYPE_IEEE_FLOAT — {00000003-0000-0010-8000-00aa00389b71} */
static const GUID GUID_IEEE_FLOAT = {0x00000003, 0x0000, 0x0010, {0x80, 0x00, 0x00, 0xaa, 0x00, 0x38, 0x9b, 0x71}};

static void describe(const WAVEFORMATEX* f, FmtInfo* out) {
  out->rate = f->nSamplesPerSec;
  out->channels = f->nChannels;
  out->bits = f->wBitsPerSample;
  out->is_float = 0;
  if (f->wFormatTag == WAVE_FORMAT_IEEE_FLOAT) out->is_float = 1;
  if (f->wFormatTag == WAVE_FORMAT_EXTENSIBLE && f->cbSize >= 22) {
    const WAVEFORMATEXTENSIBLE* we = (const WAVEFORMATEXTENSIBLE*)f;
    if (IsEqualGUID(&we->SubFormat, &GUID_IEEE_FLOAT)) out->is_float = 1;
    out->bits = we->Samples.wValidBitsPerSample;
  }
}

static void write_wav_header(FILE* f, const FmtInfo* fi) {
  DWORD data_size = 0;
  fwrite("RIFF", 1, 4, f);
  fwrite(&(DWORD){36 + data_size}, 4, 1, f);
  fwrite("WAVE", 1, 4, f);
  fwrite("fmt ", 1, 4, f);
  fwrite(&(DWORD){16}, 4, 1, f);
  fwrite(&(WORD){WAVE_FORMAT_PCM}, 2, 1, f);
  fwrite(&fi->channels, 2, 1, f);
  fwrite(&fi->rate, 4, 1, f);
  fwrite(&(DWORD){fi->rate * fi->channels * 2}, 4, 1, f);
  fwrite(&(WORD){fi->channels * 2}, 2, 1, f);
  fwrite(&(WORD){16}, 2, 1, f);
  fwrite("data", 1, 4, f);
  fwrite(&data_size, 4, 1, f);
}

static void finalize_wav(FILE* f, long long data_bytes) {
  fflush(f);
  fseek(f, 4, SEEK_SET);
  DWORD total = (DWORD)(36 + data_bytes);
  fwrite(&total, 4, 1, f);
  fseek(f, 40, SEEK_SET);
  DWORD ds = (DWORD)data_bytes;
  fwrite(&ds, 4, 1, f);
  fclose(f);
}

static int convert_to_s16(const BYTE* src, size_t frames, const FmtInfo* fi, short* dst) {
  size_t n = (size_t)frames * fi->channels;
  if (!fi->is_float) {
    if (fi->bits == 16) { memcpy(dst, src, n * 2); return 1; }
    if (fi->bits == 24) {
      for (size_t i = 0; i < n; i++) {
        int v = src[i*3] | (src[i*3+1] << 8) | ((signed char)src[i*3+2] << 16);
        dst[i] = (short)(v >> 8);
      }
      return 1;
    }
    if (fi->bits == 32) {
      const int* p = (const int*)src;
      for (size_t i = 0; i < n; i++) dst[i] = (short)(p[i] >> 16);
      return 1;
    }
    return 0;
  }
  const float* p = (const float*)src;
  for (size_t i = 0; i < n; i++) {
    float v = p[i];
    if (v > 1.0f) v = 1.0f; else if (v < -1.0f) v = -1.0f;
    dst[i] = (short)(v * 32767.0f);
  }
  return 1;
}

static int cmd_record(const char* kind, const char* path, double seconds) {
  EDataFlow flow = (strcmp(kind, "system") == 0) ? eRender : eCapture;
  DWORD flags = (flow == eRender) ? AUDCLNT_STREAMFLAGS_LOOPBACK : 0;

  CoInitializeEx(NULL, COINIT_APARTMENTTHREADED);
  IMMDeviceEnumerator* en = NULL;
  HRESULT hr = CoCreateInstance(&CLSID_MMDeviceEnumerator, NULL, CLSCTX_INPROC_SERVER,
                                &IID_IMMDeviceEnumerator, (void**)&en);
  if (FAILED(hr)) fail("CoCreateInstance", hr);
  IMMDevice* dev = NULL;
  hr = en->lpVtbl->GetDefaultAudioEndpoint(en, flow, eConsole, &dev);
  if (FAILED(hr)) {
    fprintf(stderr, "ERR no default %s endpoint (0x%08lx)\n", kind, (unsigned long)hr);
    return 1;
  }
  en->lpVtbl->Release(en);

  IAudioClient* client = NULL;
  hr = dev->lpVtbl->Activate(dev, &IID_IAudioClient, CLSCTX_ALL, NULL, (void**)&client);
  if (FAILED(hr)) fail("Activate IAudioClient", hr);
  dev->lpVtbl->Release(dev);

  WAVEFORMATEX* fmt = NULL;
  hr = client->lpVtbl->GetMixFormat(client, &fmt);
  if (FAILED(hr)) fail("GetMixFormat", hr);
  FmtInfo fi;
  describe(fmt, &fi);
  if (fi.channels == 0 || fi.rate == 0) fail("unsupported format", E_FAIL);
  emit("READY fmt=%lu:%u:%u\n", (unsigned long)fi.rate, (unsigned)fi.channels, (unsigned)fi.bits);

  REFERENCE_TIME hns = 2000000; /* 200 ms */
  hr = client->lpVtbl->Initialize(client, AUDCLNT_SHAREMODE_SHARED, flags, hns, hns, fmt, NULL);
  CoTaskMemFree(fmt);
  if (FAILED(hr)) fail("Initialize (shared)", hr);

  IAudioCaptureClient* cap = NULL;
  hr = client->lpVtbl->GetService(client, &IID_IAudioCaptureClient, (void**)&cap);
  if (FAILED(hr)) fail("GetService IAudioCaptureClient", hr);

  FILE* f = fopen(path, "wb");
  if (!f) { fprintf(stderr, "ERR cannot open %s\n", path); return 1; }
  write_wav_header(f, &fi);

  LARGE_INTEGER freq, t0;
  QueryPerformanceFrequency(&freq);
  QueryPerformanceCounter(&t0);
  long long written = 0;
  double peak = 0, last_level = 0;
  DWORD frames_per_level = (DWORD)(fi.rate / 2); /* ~0.5 s */

  SetConsoleCtrlHandler(on_ctrl, TRUE);
  hr = client->lpVtbl->Start(client);
  if (FAILED(hr)) fail("Start", hr);

  DWORD frames_in_level = 0;
  LARGE_INTEGER last_patch; QueryPerformanceCounter(&last_patch);
  while (!stop_requested()) {
    UINT32 next = 0;
    cap->lpVtbl->GetNextPacketSize(cap, &next);
    while (next > 0 && !stop_requested()) {
      BYTE* data = NULL;
      UINT32 frames = 0;
      DWORD pflags = 0;
      UINT64 dpos = 0, qpos = 0;
      hr = cap->lpVtbl->GetBuffer(cap, &data, &frames, &pflags, &dpos, &qpos);
      if (FAILED(hr)) { fprintf(stderr, "ERR GetBuffer (0x%08lx)\n", (unsigned long)hr); break; }
      if (frames > 0) {
        short* tmp = (short*)malloc((size_t)frames * fi.channels * 2);
        if (tmp && convert_to_s16(data, frames, &fi, tmp)) {
          fwrite(tmp, 2, (size_t)frames * fi.channels, f);
          written += (long long)frames * fi.channels * 2;
        }
        if (fi.is_float) {
          const float* p = (const float*)data;
          size_t n = (size_t)frames * fi.channels;
          for (size_t i = 0; i < n; i++) { float a = p[i] < 0 ? -p[i] : p[i]; if (a > peak) peak = a; }
        }
        free(tmp);
      }
      cap->lpVtbl->ReleaseBuffer(cap, frames);
      cap->lpVtbl->GetNextPacketSize(cap, &next);
      frames_in_level += frames;
      if (frames_in_level >= frames_per_level) {
        frames_in_level = 0;
        double lvl = peak * 100.0;
        if (lvl < last_level) lvl = lvl * 0.3 + last_level * 0.7;
        last_level = lvl;
        emit("LEVEL %d\n", (int)(lvl > 100 ? 100 : lvl));
        peak = 0;
      }
    }
    if (seconds > 0) {
      LARGE_INTEGER now; QueryPerformanceCounter(&now);
      if ((double)(now.QuadPart - t0.QuadPart) / freq.QuadPart >= seconds) break;
    }
    /* keep the RIFF header sizes fresh so a hard kill still yields a valid wav */
    {
      LARGE_INTEGER now; QueryPerformanceCounter(&now);
      if ((double)(now.QuadPart - last_patch.QuadPart) / freq.QuadPart >= 2.0) {
        last_patch = now;
        fflush(f);
        fseek(f, 4, SEEK_SET);
        DWORD total = (DWORD)(36 + written);
        fwrite(&total, 4, 1, f);
        fseek(f, 40, SEEK_SET);
        DWORD ds = (DWORD)written;
        fwrite(&ds, 4, 1, f);
        fseek(f, 0, SEEK_END);
      }
    }
    Sleep(5);
  }
  client->lpVtbl->Stop(client);
  SetConsoleCtrlHandler(on_ctrl, FALSE);

  LARGE_INTEGER now; QueryPerformanceCounter(&now);
  double dur = (double)(now.QuadPart - t0.QuadPart) / freq.QuadPart;
  finalize_wav(f, written);
  emit("FINISHED bytes=%lld dur=%.2f\n", written, dur);
  cap->lpVtbl->Release(cap);
  client->lpVtbl->Release(client);
  CoUninitialize();
  return 0;
}

int main(int argc, char** argv) {
  if (argc >= 2 && strcmp(argv[1], "list") == 0) {
    for (int i = 2; i < argc; i++) {
      if (strcmp(argv[i], "-o") == 0 && i + 1 < argc) g_status = fopen(argv[i + 1], "wb");
    }
    int rc = cmd_list();
    if (g_status) fclose(g_status);
    return rc;
  }
  /* who is currently making sound on the default output device (meeting-app detection) */
  if (argc >= 2 && strcmp(argv[1], "sessions") == 0) {
    for (int i = 2; i < argc; i++) {
      if (strcmp(argv[i], "-o") == 0 && i + 1 < argc) g_status = fopen(argv[i + 1], "wb");
    }
    int rc = cmd_sessions();
    if (g_status) fclose(g_status);
    return rc;
  }
  if (argc >= 4 && strcmp(argv[1], "record") == 0) {
    double seconds = 0;
    for (int i = 4; i < argc; i++) {
      if (strcmp(argv[i], "--seconds") == 0 && i + 1 < argc) seconds = atof(argv[i + 1]);
      else if (strcmp(argv[i], "--status") == 0 && i + 1 < argc) g_status = fopen(argv[i + 1], "wb");
      else if (strcmp(argv[i], "--stop") == 0 && i + 1 < argc) g_stop_file = argv[i + 1];
    }
    int rc = cmd_record(argv[2], argv[3], seconds);
    if (g_status) fclose(g_status);
    return rc;
  }
  fprintf(stderr, "ERR usage: capture.exe list [-o file] | sessions [-o file] | record <system|mic> <out.wav> [--seconds N] [--status file]\n");
  return 1;
}
