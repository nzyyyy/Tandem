import Foundation

struct ConversationPosition: Codable, Equatable {
    var generation: String
    var sequence: Int
    var atBottom: Bool
    var projectFilter: String
}

@MainActor
final class ConversationPositionStore {
    static let shared = ConversationPositionStore()
    private let defaults: UserDefaults
    private var claimedSurfaces: Set<String> = []
    private let lastSurfaceKey = "tandem.lastConversationSurface"
    private let positionPrefix = "tandem.conversationPosition."

    init(defaults: UserDefaults = .standard) { self.defaults = defaults }

    func claimSurface(preferred: String) -> String {
        let candidate = preferred.isEmpty && claimedSurfaces.isEmpty
            ? defaults.string(forKey: lastSurfaceKey) ?? "" : preferred
        let id = !candidate.isEmpty && !claimedSurfaces.contains(candidate) ? candidate : UUID().uuidString
        claimedSurfaces.insert(id)
        return id
    }

    func activate(_ surfaceId: String) {
        guard !surfaceId.isEmpty else { return }
        defaults.set(surfaceId, forKey: lastSurfaceKey)
    }

    func position(for surfaceId: String, generation: String) -> ConversationPosition? {
        guard let data = defaults.data(forKey: positionPrefix + surfaceId),
              let position = try? JSONDecoder().decode(ConversationPosition.self, from: data),
              position.generation == generation, position.sequence > 0 else { return nil }
        return position
    }

    func save(_ position: ConversationPosition, for surfaceId: String) {
        guard !surfaceId.isEmpty, position.sequence > 0, let data = try? JSONEncoder().encode(position),
              defaults.data(forKey: positionPrefix + surfaceId) != data else { return }
        defaults.set(data, forKey: positionPrefix + surfaceId)
    }
}
