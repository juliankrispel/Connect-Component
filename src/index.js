import React, { createElement, Component } from 'react';
import shallowCompare from 'react-addons-shallow-compare';
import hoistStatics from 'hoist-non-react-statics';
import PropTypes from 'prop-types';
import invariant from 'invariant';
import mapDispatchToPropsFactories from './connect/mapDispatchToProps';
import Subscription from './utils/Subscription';
import selectorFactory from './connect/selectorFactory';
import mapStateToPropsFactories from './connect/mapStateToProps';
import mergePropsFactories from './connect/mergeProps';
import shallowEqual from './utils/shallowEqual';

const strictEqual = (a, b) => a === b;

const defaultOpts = {
  getDisplayName: name => `Connect(${name})`,
  pure: true,
  withRef: false,
  areStatesEqual: strictEqual,
  areOwnPropsEqual: shallowEqual,
  areStatePropsEqual: shallowEqual,
  areMergedPropsEqual: shallowEqual
};

let hotReloadingVersion = 0;

export const subscriptionShape = PropTypes.shape({
  trySubscribe: PropTypes.func.isRequired,
  tryUnsubscribe: PropTypes.func.isRequired,
  notifyNestedSubs: PropTypes.func.isRequired,
  isSubscribed: PropTypes.func.isRequired
});

export const storeShape = PropTypes.shape({
  subscribe: PropTypes.func.isRequired,
  dispatch: PropTypes.func.isRequired,
  getState: PropTypes.func.isRequired
});

function match(arg, factories, name) {
  for (let i = factories.length - 1; i >= 0; i--) {
    const result = factories[i](arg);
    if (result) return result;
  }

  return (dispatch, options) => {
    throw new Error(
      `Invalid value of type ${typeof arg} for ${name} argument when connecting component ${options.wrappedComponentName}.`
    );
  };
}

const withRef = false;
const methodName = 'connect';
const storeKey = 'store';
const subscriptionKey = storeKey + 'Subscription';

const dummyState = {};
function noop() {}
function makeSelectorStateful(sourceSelector, store) {
  // wrap the selector in an object that tracks its results between runs.
  const selector = {
    run: function runComponentSelector(props) {
      try {
        const nextProps = sourceSelector(store.getState(), props);
        if (nextProps !== selector.props || selector.error) {
          selector.shouldComponentUpdate = true;
          selector.props = nextProps;
          selector.error = null;
        }
      } catch (error) {
        selector.shouldComponentUpdate = true;
        selector.error = error;
      }
    }
  };

  return selector;
}

class Connect extends Component {
  constructor(props, context) {
    super(props, context);

    this.state = {};
    this.store = props[storeKey] || context[storeKey];
    this.propsMode = Boolean(props[storeKey]);
    this.setWrappedInstance = this.setWrappedInstance.bind(this);

    this.initialize();

    invariant(
      this.store,
      `Could not find "${storeKey}" in either the context or props of ` +
        `"${this.constructor
          .displayName}". Either wrap the root component in a <Provider>, ` +
        `or explicitly pass "${storeKey}" as a prop to "${this.constructor
          .displayName}".`
    );

    this.initSelector();
    this.initSubscription();
  }

  shouldHandleStateChanges = () => Boolean(this.getOptions().mapStateToProps);

  getChildContext() {
    // If this component received store from props, its subscription should be transparent
    // to any descendants receiving store+subscription from context; it passes along
    // subscription passed to it. Otherwise, it shadows the parent subscription, which allows
    // Connect to control ordering of notifications to flow top-down.
    const subscription = this.propsMode ? null : this.subscription;
    return { [subscriptionKey]: subscription || this.context[subscriptionKey] };
  }

  componentDidMount() {
    if (!this.shouldHandleStateChanges()) return;

    // componentWillMount fires during server side rendering, but componentDidMount and
    // componentWillUnmount do not. Because of this, trySubscribe happens during ...didMount.
    // Otherwise, unsubscription would never take place during SSR, causing a memory leak.
    // To handle the case where a child component may have triggered a state change by
    // dispatching an action in its componentWillMount, we have to re-run the select and maybe
    // re-render.
    this.subscription.trySubscribe();
    this.selector.run(this.getRestProps());
    if (this.selector.shouldComponentUpdate) this.forceUpdate();
  }

  componentWillReceiveProps(nextProps) {
    this.selector.run(this.getRestProps(nextProps));
  }

  shouldComponentUpdate() {
    return this.selector.shouldComponentUpdate;
  }

  componentWillUnmount() {
    if (this.subscription) this.subscription.tryUnsubscribe();
    this.subscription = null;
    this.notifyNestedSubs = noop;
    this.store = null;
    this.selector.run = noop;
    this.selector.shouldComponentUpdate = false;
  }

  getWrappedInstance() {
    const { options: { withRef } } = this.getOptions();

    invariant(
      withRef,
      `To access the wrapped instance, you need to specify ` +
        `{ withRef: true } in the options argument of the ${methodName}() call.`
    );
    return this.wrappedInstance;
  }

  setWrappedInstance(ref) {
    this.wrappedInstance = ref;
  }

  getOptions = () => this.staticOpts || this.props;

  initSelector() {
    const {
      mapStateToProps,
      mapDispatchToProps,
      mergeProps,
      options
    } = this.getOptions();

    const initMapStateToProps = match(
      mapStateToProps,
      mapStateToPropsFactories,
      'mapStateToProps'
    );

    const initMapDispatchToProps = match(
      mapDispatchToProps,
      mapDispatchToPropsFactories,
      'mapDispatchToProps'
    );
    const initMergeProps = match(mergeProps, mergePropsFactories, 'mergeProps');

    const selectorFactoryOptions = {
      initMapStateToProps,
      initMapDispatchToProps,
      initMergeProps,
      ...(options || {}),
      methodName,
      shouldHandleStateChanges: this.shouldHandleStateChanges(),
      storeKey,
      displayName: this.constructor.displayName
    };

    const sourceSelector = selectorFactory(
      this.store.dispatch,
      selectorFactoryOptions
    );
    this.selector = makeSelectorStateful(sourceSelector, this.store);
    this.selector.run(this.getRestProps());
  }

  getRestProps = (
    {
      mapStateToProps,
      mapDispatchToProps,
      mergeProps,
      options,
      children,
      ...otherProps
    } = this.props
  ) => otherProps;

  initSubscription = () => {
    if (!this.shouldHandleStateChanges()) return;

    // parentSub's source should match where store came from: props vs. context. A component
    // connected to the store via props shouldn't use subscription from context, or vice versa.
    const parentSub = (this.propsMode ? this.props : this.context)[
      subscriptionKey
    ];

    this.subscription = new Subscription(
      this.store,
      parentSub,
      this.onStateChange.bind(this)
    );

    // `notifyNestedSubs` is duplicated to handle the case where the component is  unmounted in
    // the middle of the notification loop, where `this.subscription` will then be null. An
    // extra null check every change can be avoided by copying the method onto `this` and then
    // replacing it with a no-op on unmount. This can probably be avoided if Subscription's
    // listeners logic is changed to not call listeners that have been unsubscribed in the
    // middle of the notification loop.
    this.notifyNestedSubs = this.subscription.notifyNestedSubs.bind(
      this.subscription
    );
  };

  onStateChange() {
    this.selector.run(this.getRestProps());

    if (!this.selector.shouldComponentUpdate) {
      this.notifyNestedSubs();
    } else {
      this.componentDidUpdate = this.notifyNestedSubsOnComponentDidUpdate;
      this.setState(dummyState);
    }
  }

  notifyNestedSubsOnComponentDidUpdate() {
    // `componentDidUpdate` is conditionally implemented when `onStateChange` determines it
    // needs to notify nested subs. Once called, it unimplements itself until further state
    // changes occur. Doing it this way vs having a permanent `componentDidUpdate` that does
    // a boolean check every time avoids an extra method call most of the time, resulting
    // in some perf boost.
    this.componentDidUpdate = undefined;
    this.notifyNestedSubs();
  }

  isSubscribed() {
    return Boolean(this.subscription) && this.subscription.isSubscribed();
  }

  addExtraProps(props) {
    const { options: { withRef } } = this.getOptions();
    if (!withRef && !(this.propsMode && this.subscription)) return props;
    // make a shallow copy so that fields added don't leak to the original selector.
    // this is especially important for 'ref' since that's a reference back to the component
    // instance. a singleton memoized selector would then be holding a reference to the
    // instance, preventing the instance from being garbage collected, and that would be bad
    const withExtras = { ...props };
    if (withRef) withExtras.ref = this.setWrappedInstance;
    if (this.propsMode && this.subscription)
      withExtras[subscriptionKey] = this.subscription;
    return withExtras;
  }

  renderChild() {
    return this.props.children(this.addExtraProps(this.selector.props));
  }

  render() {
    const selector = this.selector;
    selector.shouldComponentUpdate = false;

    if (selector.error) {
      throw selector.error;
    } else {
      return this.renderChild();
    }
  }
}

const contextTypes = {
  [storeKey]: storeShape,
  [subscriptionKey]: subscriptionShape
};

const childContextTypes = {
  [subscriptionKey]: subscriptionShape
};

Connect.childContextTypes = childContextTypes;
Connect.contextTypes = contextTypes;
Connect.propTypes = contextTypes;

Connect.defaultProps = { options: defaultOpts };

export const connect = (
  mapStateToProps,
  mapDispatchToProps,
  mergeProps,
  options
) => WrappedComponent => {
  invariant(
    typeof WrappedComponent == 'function',
    `You must pass a component to the function returned by ` +
      `connect. Instead received ${JSON.stringify(WrappedComponent)}`
  );

  const wrappedComponentName =
    WrappedComponent.displayName || WrappedComponent.name || 'Component';

  const opts = {
    mapStateToProps,
    mapDispatchToProps,
    mergeProps,
    options: {
      wrappedComponentName,
      ...defaultOpts,
      ...options
    }
  };

  class ConnectWrap extends Connect {
    initialize() {
      this.staticOpts = opts;
    }

    renderChild() {
      const props = this.addExtraProps(this.selector.props);
      const children = this.props.children;

      return <WrappedComponent {...props} children={children} />;
    }
  }

  ConnectWrap.WrappedComponent = WrappedComponent;
  ConnectWrap.displayName = opts.options.getDisplayName(wrappedComponentName);

  return hoistStatics(ConnectWrap, WrappedComponent);
};

export default Connect;
