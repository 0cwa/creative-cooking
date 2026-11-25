import { createContext, forwardRef, useContext, type ComponentRef } from 'react';
import {
  Pressable as NativePressable,
  Text as NativeText,
  TextInput as NativeTextInput,
  type PressableProps,
  type TextInputProps,
  type TextProps
} from 'react-native';
import { palette, useColorSchemeValue } from '@/theme/StyleSheet';

// Drop-in replacements for the React Native primitives used by panels that
// carry no styling of their own (recovery, household and device tools). They
// give text a readable theme colour, inputs a visible field and buttons a
// button shape, while any style the caller passes still wins.

const InsideButton = createContext(false);

export const Text = forwardRef<ComponentRef<typeof NativeText>, TextProps>(function Text(props, ref) {
  const colors = palette(useColorSchemeValue());
  const inButton = useContext(InsideButton);
  const role = props.accessibilityRole ?? props.role;
  const base = inButton
    ? { color: colors.text, fontWeight: '700' as const, fontSize: 14, lineHeight: 20 }
    : role === 'header'
      ? { color: colors.text, fontWeight: '800' as const, fontSize: 16, lineHeight: 22 }
      : role === 'alert'
        ? { color: colors.danger, fontSize: 14, lineHeight: 20 }
        : { color: colors.text, fontSize: 14, lineHeight: 21 };
  return <NativeText ref={ref} {...props} style={[base, props.style]} />;
});

export const TextInput = forwardRef<ComponentRef<typeof NativeTextInput>, TextInputProps>(function TextInput(props, ref) {
  const colors = palette(useColorSchemeValue());
  return (
    <NativeTextInput
      ref={ref}
      placeholderTextColor={colors.placeholder}
      {...props}
      style={[
        {
          minHeight: 44,
          borderWidth: 1,
          borderColor: colors.border,
          borderRadius: 10,
          backgroundColor: colors.field,
          color: colors.text,
          paddingHorizontal: 12,
          paddingVertical: 10,
          fontSize: 15
        },
        props.editable === false && { opacity: 0.6 },
        props.style
      ]}
    />
  );
});

export const Pressable = forwardRef<ComponentRef<typeof NativePressable>, PressableProps>(function Pressable(props, ref) {
  const colors = palette(useColorSchemeValue());
  const role = props.accessibilityRole ?? props.role;
  if (role !== 'button') return <NativePressable ref={ref} {...props} />;
  const { style } = props;
  const base = {
    alignSelf: 'flex-start' as const,
    minHeight: 40,
    justifyContent: 'center' as const,
    paddingHorizontal: 14,
    paddingVertical: 9,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: colors.border,
    backgroundColor: colors.control
  };
  return (
    <InsideButton.Provider value>
      <NativePressable
        ref={ref}
        {...props}
        style={state => [
          base,
          state.pressed && { opacity: 0.75 },
          props.disabled && { opacity: 0.45 },
          typeof style === 'function' ? style(state) : style
        ]}
      />
    </InsideButton.Provider>
  );
});
