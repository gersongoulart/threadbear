Feature: Fork a conversation
  As someone trying another direction
  I want an independent conversation with a clear choice about shared files
  So I can carry on without changing the original conversation

  Background:
    Given the app is connected to a runner with the demo threads
    And I open the thread "Morning brief"

  @threads.fork @swift-pending
  Scenario: A reply's inline icon forks through that reply and leaves later replies out
    Given this conversation has a later reply
    When I click the first reply's inline fork icon
    Then the chooser is scoped to the first reply
    When I create the fork
    Then the idle fork "Morning brief (fork)" opens
    And the fork contains the first reply without the later reply

  # Swift is frozen; this is a new GPUI experiment.
  @threads.fork @swift-pending
  Scenario: The slash command opens the chooser without sending a message
    When I open the fork chooser with the slash command
    Then the fork chooser offers shared files
    When I create the fork
    And I click Fork again while it is creating
    Then the idle fork "Morning brief (fork)" opens
    And the transcript doesn't show my message "/fork"
    When I follow the source conversation link
    Then the original conversation opens

  @threads.fork @swift-pending
  Scenario: A separate worktree explains which files stay out
    When I open the fork chooser from the thread menu
    And I choose a separate worktree
    Then the fork chooser names the excluded untracked files
    When I create the fork
    Then the idle fork "Morning brief (fork)" opens

  @threads.fork @swift-pending
  Scenario: A failed copy stays open and can be retried
    Given the next fork copy will fail
    When I open the fork chooser with the slash command
    And I create the fork
    Then the fork chooser shows the copy error
    When I retry the fork
    Then the idle fork "Morning brief (fork)" opens

  @threads.fork @swift-pending
  Scenario: A folder outside Git offers only shared files
    Given the fork source is outside Git
    When I open the fork chooser with the slash command
    Then the fork chooser disables a separate worktree

  @threads.fork @swift-pending @remote-threads
  Scenario: A remote fork stays on its owning runner
    Given I open the thread "Check the photo library backup"
    When I open the fork chooser with the slash command
    And I create the fork
    Then the idle fork "Check the photo library backup (fork)" opens
    And the fork remains on bruce

  @threads.fork @swift-pending
  Scenario: A busy source explains why it cannot be forked yet
    Given I open the thread "Why is the build slow on CI?"
    When I request a fork of the busy conversation
    Then the chooser asks me to wait for the turn
    And the transcript doesn't show my message "/fork"

  @threads.fork @swift-pending
  Scenario: Cancelling the chooser lets me open it again
    When I open the fork chooser with the slash command
    And I cancel the fork chooser
    Then the fork chooser is closed
    When I open the fork chooser from the thread menu
    Then the fork chooser offers shared files
