import Foundation

public struct ActivityState: Codable, Equatable {
    public var runs: [ActivityRun]
    public var approvals: [ApprovalCard]
    public var tasks: [PersistentTask]
    public var grants: [DirectoryGrant]
}
public struct ActivityRun: Codable, Equatable, Identifiable {
    public var id: String
    public var status: String
    public var error_code: String?
    public var project_id: String?
    public var assistant_message_id: String
    public var version: Int
    public var steps: Int
    public var tokens: Int
    public var active_ms: Int
    public var step_limit: Int
    public var token_limit: Int
    public var time_limit: Int
    public var pause_reason: String?
    public var estimated: Int
    public var modelName: String
    public var task_id: String?
    public var revision: Int?
    public var stepsDetail: [ExecutionStep]
}
public struct ExecutionStep: Codable, Equatable, Identifiable {
    public var id: String
    public var kind: String
    public var status: String
    public var snapshot_id: String?
    public var detail: String
    public var summary: String {
        guard let data = detail.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return kind }
        return [value["name"] as? String, value["path"] as? String, value["error"] as? String, value["modelName"] as? String].compactMap { $0 }.joined(separator: " · ")
    }
}
public struct ApprovalCard: Codable, Equatable, Identifiable {
    public var id: String
    public var run_id: String
    public var name: String
    public var args: String
    public var expires_at: Double
    public var reason: String {
        guard let data = args.data(using: .utf8), let value = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { return "读取本地资料" }
        return value["reason"] as? String ?? "读取本地资料"
    }
}
public struct DirectoryGrant: Codable, Equatable, Identifiable {
    public var id: String
    public var project_id: String?
    public var label: String
    public var status: String
}
public struct PersistentTask: Codable, Equatable, Identifiable {
    public var id: String
    public var project_id: String?
    public var session_id: String
    public var revision: Int
    public var status: String
    public var deliverable: String
    public var criteria: String
    public var evidence: String?
    public var result_ref: String?
    public var criteriaList: [String] { (try? JSONDecoder().decode([String].self, from: Data(criteria.utf8))) ?? [] }
    public var evidenceList: [String] { (try? JSONDecoder().decode([String].self, from: Data((evidence ?? "[]").utf8))) ?? [] }
}
public func executionStatus(_ value: String) -> String {
    ["queued":"排队", "running":"执行中", "waiting_approval":"等待审批", "paused":"预算暂停", "completed":"已完成", "failed":"失败", "cancelled":"已取消", "interrupted":"已中断", "open":"未完成"][value] ?? value
}
