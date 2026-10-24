export interface CloudDictationSettings { enabled: boolean; }
export interface CloudDictationSettingsStore {
  readonly filePath: string;
  read(): CloudDictationSettings;
  write(next: CloudDictationSettings): CloudDictationSettings;
}
export declare function createCloudDictationSettings(options: { userDataPath: string }): CloudDictationSettingsStore;