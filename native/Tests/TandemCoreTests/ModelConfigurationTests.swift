import XCTest
@testable import TandemCore

final class ModelConfigurationTests: XCTestCase {
    private func legacyConfiguration() throws -> AppConfiguration {
        let json = #"{"schemaVersion":1,"modelConnections":[{"id":"primary","protocol":"openai","apiType":"responses","url":"https://example.com/v1","key":"test-key","modelNames":["model-a"]}],"defaultModel":{"connectionId":"primary","modelName":"model-a"}}"#
        return try JSONDecoder().decode(AppConfiguration.self, from: Data(json.utf8))
    }

    func testLegacyProviderCanBeRenamedWithoutChangingIdentity() throws {
        var config = try legacyConfiguration()
        XCTAssertNil(config.modelConnections[0].name)
        XCTAssertEqual(config.modelConnections[0].displayName, "example.com")
        config.modelConnections[0].name = "我的供应商"
        let reloaded = try JSONDecoder().decode(AppConfiguration.self, from: JSONEncoder().encode(config))
        XCTAssertEqual(reloaded.modelConnections[0].displayName, "我的供应商")
        XCTAssertEqual(reloaded.modelConnections[0].id, "primary")
        XCTAssertEqual(reloaded.defaultModel, ModelSelection(connectionId: "primary", modelName: "model-a"))
    }

    func testModelListValidatesAndNormalizesAdditions() {
        var connection = ModelConnection.new()
        XCTAssertFalse(connection.addModel("  "))
        XCTAssertTrue(connection.addModel(" model-a "))
        XCTAssertEqual(connection.modelNames, ["model-a"])
        XCTAssertFalse(connection.addModel("model-a"))
        XCTAssertFalse(connection.addModel("model\nname"))
        XCTAssertFalse(connection.addModel(String(repeating: "x", count: 257)))
        XCTAssertFalse(connection.addModel(String(repeating: "😀", count: 129)))
        for index in 1..<20 { XCTAssertTrue(connection.addModel("model-\(index)")) }
        XCTAssertFalse(connection.addModel("overflow"))
        XCTAssertEqual(connection.modelNames.count, 20)
    }

    func testRemovingDefaultModelClearsOnlyMatchingSelection() throws {
        var config = try legacyConfiguration()
        XCTAssertTrue(config.modelConnections[0].addModel("model-b"))
        config.removeModel("model-a", from: "other-provider")
        XCTAssertNotNil(config.defaultModel)
        config.removeModel("model-b", from: "primary")
        XCTAssertNotNil(config.defaultModel)
        config.removeModel("model-a", from: "primary")
        XCTAssertNil(config.defaultModel)
        XCTAssertEqual(config.modelConnections[0].modelNames, [])
    }
}
