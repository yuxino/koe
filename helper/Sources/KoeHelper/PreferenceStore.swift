import Foundation
import KoeHelperCore

struct PreferenceStore {
    private let fileURL: URL

    init(root: URL? = nil) throws {
        let directory = root ?? FileManager.default
            .urls(for: .applicationSupportDirectory, in: .userDomainMask)[0]
            .appendingPathComponent("Koe", isDirectory: true)
        try FileManager.default.createDirectory(
            at: directory,
            withIntermediateDirectories: true,
            attributes: [.posixPermissions: 0o700]
        )
        self.fileURL = directory.appendingPathComponent("preferences.json", isDirectory: false)
    }

    func load() -> KoePreferences? {
        guard let data = try? Data(contentsOf: fileURL), data.count <= 64 * 1_024,
              let decoded = try? JSONDecoder().decode(KoePreferences.self, from: data) else {
            return nil
        }
        return KoePreferences.normalized(decoded)
    }

    func save(_ preferences: KoePreferences) throws {
        let data = try JSONEncoder().encode(KoePreferences.normalized(preferences))
        try data.write(to: fileURL, options: .atomic)
        try FileManager.default.setAttributes([.posixPermissions: 0o600], ofItemAtPath: fileURL.path)
    }
}
